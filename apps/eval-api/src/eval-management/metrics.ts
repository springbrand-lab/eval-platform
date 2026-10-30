import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import type { MetricSummary, ResourceStatistics, StageStatistics } from "@eval-platform/eval-metrics";
import type { Context } from "hono";
import type { z } from "zod";
import type { AppBindings } from "../lib/types.js";
import { fitsTaktResult, jsonChunk, pageOf, redactLiteral, requireRun, sensitiveJsonPointer, short, type JsonChunkResult } from "./common.js";
import type { getMetricsSchema } from "./schemas.js";

function stage(value: StageStatistics) {
  return {
    records: value.records, statuses: value.statuses, successRate: value.successRate,
    attempts: value.attempts, restarts: value.restarts, agentDurationMs: value.agentDurationMs,
  };
}

function safeLabel(value: unknown, length = 160) {
  const original = typeof value === "string" ? value : "";
  const safe = redactLiteral(original);
  return { value: safe.redacted ? safe.value : short(original, length),
    redacted: safe.redacted, truncated: !safe.redacted && original.length > length };
}

/** Projection of already-computed Metrics facts; never infer missing resources from stage status. */
export function resourceSummary(item: ResourceStatistics, toolPage?: number, toolPageSize?: number) {
  const base = {
    coverage: item.coverage, collections: item.collections, tokens: item.tokens,
    costs: item.costs, cacheHitRate: item.cacheHitRate,
    toolSuccessRate: item.trajectory.toolSuccessRate,
  };
  // inspect_case keeps its existing projection. get_metrics pages both roles independently,
  // forwarding Metrics' native Tool success rates without recalculation or raw Tool bodies.
  if (toolPage === undefined || toolPageSize === undefined) return base;
  if (!Array.isArray(item.trajectory.byTool)) {
    throw new HttpError("RESPONSE_INVALID", "Metrics has no per-Tool facts");
  }
  const tools = pageOf(item.trajectory.byTool, toolPage, toolPageSize);
  return { ...base, byTool: { ...tools, items: tools.items.map((tool) => {
    if (tool.toolName !== null && typeof tool.toolName !== "string") {
      throw new HttpError("RESPONSE_INVALID", "Metrics returned an invalid Tool name");
    }
    const name = tool.toolName === null ? { value: null, redacted: false }
      : tool.toolName.length > 96 ? { value: "[REDACTED: sensitive source content]", redacted: true }
        : redactLiteral(tool.toolName);
    return {
      toolName: name.value, sourceRedacted: name.redacted,
      count: tool.count, coverage: tool.count.coverage,
      completed: tool.completed, failed: tool.failed, cancelled: tool.cancelled,
      inProgress: tool.inProgress, unknown: tool.unknown, toolSuccessRate: tool.toolSuccessRate,
    };
  }) } };
}

/** Project Metrics calculates every statistic. This only drops bulky, model-visible payloads. */
export function metricSummary(value: MetricSummary, page: number, pageSize: number,
  toolPage?: number, toolPageSize?: number) {
  const fieldPage = pageOf(value.evaluationOutputs.fields, page, pageSize);
  const fields = fieldPage.items.map((field) => {
    const pointer = safeLabel(field.jsonPointer);
    const title = safeLabel(field.title);
    const sensitive = pointer.redacted || sensitiveJsonPointer(field.jsonPointer);
    const distribution = field.distribution.slice(0, 10).map(({ value: entry, count, share }) => {
      const safe = typeof entry === "string" ? safeLabel(entry, 80) : null;
      return { value: sensitive ? "[REDACTED: sensitive source content]" : safe?.value ?? entry, count, share,
        ...(sensitive || safe?.redacted ? { sourceRedacted: true } : {}),
        ...(!sensitive && safe?.truncated ? { truncated: true } : {}) };
    });
    return {
      jsonPointer: pointer.value, title: title.value, kinds: field.kinds,
      observationCount: field.observationCount,
      contributingEvaluationCount: field.contributingEvaluationCount,
      missingEvaluationCount: field.missingEvaluationCount, numeric: sensitive ? null : field.numeric,
      ...(sensitive && field.numeric !== null ? { numericRedacted: true } : {}),
      distributionCount: field.distribution.length, distribution,
      ...(field.distribution.length > distribution.length ? { distributionTruncated: true } : {}),
      ...(sensitive || title.redacted || distribution.some((entry) => entry.sourceRedacted)
        ? { sourceRedacted: true } : {}),
      ...(pointer.truncated ? { jsonPointerTruncated: true } : {}),
      ...(title.truncated ? { titleTruncated: true } : {}),
      coverage: field.coverage,
    };
  });
  return {
    counts: value.counts,
    execution: stage(value.execution), evaluation: stage(value.evaluation),
    executionAgent: resourceSummary(value.executionAgent, toolPage, toolPageSize),
    evaluationAgents: resourceSummary(value.evaluationAgents, toolPage, toolPageSize),
    evaluationOutputs: {
      evaluations: value.evaluationOutputs.evaluations,
      validation: value.evaluationOutputs.validation,
      fields: { ...fieldPage, items: fields },
    },
  };
}

/** One selected numeric *field*, not a Tool success rate or an individual Evaluation score. */
function sampleScoreIndex(summary: MetricSummary, numericPointer: string) {
  const field = summary.evaluationOutputs.fields.find((item) =>
    item.jsonPointer === numericPointer && item.numeric !== null);
  const label = field ? safeLabel(field.jsonPointer) : null;
  const sensitive = field !== undefined && (label!.redacted || sensitiveJsonPointer(field.jsonPointer));
  return {
    evaluations: summary.evaluation.records, statuses: summary.evaluation.statuses,
    validation: summary.evaluationOutputs.validation,
    field: field === undefined ? null : {
      jsonPointer: label!.value, value: sensitive ? null : field.numeric!.mean,
      coverage: field.coverage, observationCount: field.observationCount,
      contributingEvaluationCount: field.contributingEvaluationCount,
      missingEvaluationCount: field.missingEvaluationCount,
      ...(sensitive ? { sourceRedacted: true } : {}),
      ...(label!.truncated ? { jsonPointerTruncated: true } : {}),
    },
  };
}

interface SamplingSelection {
  readonly projectId: string;
  readonly samplingId: string;
  readonly runId?: string | undefined;
  readonly evaluationId?: string;
}

/** The same owner/current/optional original-Run checks guard both MCP and trusted JSON GET. */
async function ownedSampling(c: Context<AppBindings>, { projectId, samplingId, runId, evaluationId }: SamplingSelection) {
  if (evaluationId !== undefined && runId !== undefined) {
    // The original Run and today's current Metrics members must *both* authorize this Evaluation.
    const owned = await requireRun(c.var.services, projectId, runId);
    if (owned.run.runId !== runId || owned.run.projectId !== projectId
      || !owned.run.samplingIds.includes(samplingId)) throw new HttpError("SAMPLING_NOT_FOUND");
    if (!owned.run.evaluationIds.includes(evaluationId)
      || !owned.evaluations.some((item) => item.evaluationId === evaluationId && item.samplingId === samplingId)) {
      throw new HttpError("EVALUATION_NOT_FOUND");
    }
  }
  const view = await c.var.services.metrics.getSamplingDetail(
    runId === undefined ? { projectId, samplingId } : { projectId, runIds: [runId], samplingId });
  if (view.project.projectId !== projectId || view.project.ownerUserId !== c.var.user.id
    || view.projectSample.projectId !== projectId || view.sampling.projectId !== projectId
    || view.sampling.samplingId !== samplingId
    || view.sampling.projectSampleId !== view.projectSample.projectSampleId
    || view.sampling.subjectAgent.ownerUserId !== c.var.user.id
    || view.subject.role !== "subject" || view.subject.samplingId !== samplingId
    || view.subject.evaluationId !== null || view.subject.agentConfigRef.ownerUserId !== c.var.user.id
    || view.subject.chatId !== (view.sampling.subjectChatId ?? null)
    || runId !== undefined && !view.runIds.includes(runId)) throw new HttpError("SAMPLING_NOT_FOUND");
  if (view.evaluations.some(({ record, agent, output }) => record.samplingId !== samplingId
    || record.evaluator.ownerUserId !== c.var.user.id
    || agent.role !== "evaluator" || agent.evaluationId !== record.evaluationId
    || agent.samplingId !== samplingId || agent.agentConfigRef.ownerUserId !== c.var.user.id
    || agent.chatId !== (record.chatId ?? null)
    || output.evaluationId !== record.evaluationId || output.samplingId !== samplingId)) {
    throw new HttpError("EVALUATION_NOT_FOUND");
  }
  return view;
}

/** Never infer a result from Metrics numeric summaries: use its parsed output and validation. */
export async function readOwnedEvaluationResult(
  c: Context<AppBindings>, input: SamplingSelection & { readonly evaluationId: string },
) {
  const view = await ownedSampling(c, input);
  const selected = view.evaluations.filter(({ record }) => record.evaluationId === input.evaluationId);
  if (selected.length !== 1) throw new HttpError("EVALUATION_NOT_FOUND");
  const { output } = selected[0]!;
  if (output.outputStatus !== null && output.outputStatus !== "succeeded" && output.outputStatus !== "failed"
    || output.contentHash !== null && typeof output.contentHash !== "string") {
    throw new HttpError("RESPONSE_INVALID", "Invalid Evaluation output metadata");
  }
  const hash = output.contentHash === null ? null : redactLiteral(output.contentHash);
  if (hash && output.contentHash!.length > 128) throw new HttpError("RESPONSE_INVALID", "Invalid result content hash");
  // Metrics parses JSON before checking the Schema: a schema-mismatched result is
  // still a complete parsed document, even though it must not count as a score.
  const hasParsedDocument = output.validation.reason === "valid" || output.validation.reason === "schema-mismatch"
    || output.validation.reason === "no-schema" || output.validation.reason === "invalid-schema";
  if (hasParsedDocument && (typeof output.content !== "string"
    || output.rawJson === null && output.content.trim() !== "null")) {
    throw new HttpError("RESPONSE_INVALID", "A parsed result has no matching source text");
  }
  return { view, output, contentHash: hash?.value ?? null, hashRedacted: hash?.redacted ?? false,
    hasParsedDocument,
    privatePrompts: [view.projectSample.data.userPrompt, view.projectSample.data.evalPrompt]
      .filter((prompt): prompt is string => typeof prompt === "string") };
}

type Query = z.output<typeof getMetricsSchema>;

export async function getMetrics(c: Context<AppBindings>, input: Query) {
  const { projectId, runId, scope, page, pageSize, toolPage, toolPageSize, evaluationId } = input;
  // Normal reads rely on one owner-scoped Metrics snapshot. Selected exact-Run output also checks
  // the original Run's Evaluation membership before reading today's current Metrics members.
  const query = runId === undefined ? { projectId } : { projectId, runIds: [runId] };
  const runScope = runId === undefined
    ? { runScope: "project_current" as const } : { runScope: "exact_run" as const, runId };
  const metrics = c.var.services.metrics;
  const project = (value: { projectId: string; name: string }) => {
    const name = safeLabel(value.name);
    return { projectId: value.projectId, name: name.value,
      ...(name.redacted ? { sourceRedacted: true } : {}),
      ...(name.truncated ? { nameTruncated: true } : {}) };
  };
  const sample = (value: { projectSampleId: string; dataId: string; datasetIds: readonly string[]; samplingCount: number }) => ({
    projectSampleId: value.projectSampleId, dataId: value.dataId, samplingCount: value.samplingCount,
    datasetIds: value.datasetIds.slice(0, 10), datasetCount: value.datasetIds.length,
  });
  if (scope === "project") {
    const view = await metrics.getProjectOverview(query);
    const datasetPage = pageOf(view.datasets, page, pageSize);
    const samplePage = pageOf(view.projectSamples, page, pageSize);
    return { scope, project: project(view.project), ...runScope,
      summary: metricSummary(view.summary, page, pageSize, toolPage, toolPageSize),
      datasets: { ...datasetPage, items: datasetPage.items.map(({ dataset, summary }) => {
        const name = safeLabel(dataset.name);
        return { datasetId: dataset.datasetId, name: name.value, counts: summary.counts,
          ...(name.redacted ? { sourceRedacted: true } : {}),
          ...(name.truncated ? { nameTruncated: true } : {}) };
      }) },
      projectSamples: { ...samplePage, items: samplePage.items.map((item) => ({
        ...sample(item), scoreIndex: sampleScoreIndex(item.summary, input.numericPointer ?? "/score"),
        currentSamplingCount: item.samplingIds.length,
        samplingIds: pageOf(item.samplingIds, 1, pageSize),
      })) },
    };
  }
  if (scope === "dataset") {
    const view = await metrics.getDatasetOverview({ ...query, datasetId: input.datasetId! });
    const samplePage = pageOf(view.projectSamples, page, pageSize);
    const name = safeLabel(view.dataset.name);
    return { scope, project: project(view.project), ...runScope,
      dataset: { datasetId: view.dataset.datasetId, name: name.value,
        ...(name.redacted ? { sourceRedacted: true } : {}),
        ...(name.truncated ? { nameTruncated: true } : {}) },
      summary: metricSummary(view.summary, page, pageSize, toolPage, toolPageSize),
      projectSamples: { ...samplePage, items: samplePage.items.map((item) => ({
        ...sample(item), scoreIndex: sampleScoreIndex(item.summary, input.numericPointer ?? "/score"),
      })) } };
  }
  if (scope === "sample") {
    const view = await metrics.getSampleOverview({ ...query, projectSampleId: input.projectSampleId! });
    const samplingPage = pageOf(view.samplings, page, pageSize);
    return { scope, project: project(view.project), ...runScope, projectSample: sample(view.projectSample),
      summary: metricSummary(view.summary, page, pageSize, toolPage, toolPageSize),
      samplings: { ...samplingPage, items: samplingPage.items.map((item) => ({
        samplingId: item.samplingId, status: item.execution.status,
        counts: item.summary.counts, artifactCount: item.artifactCount, hasTrajectory: item.hasTrajectory,
      })) } };
  }
  const samplingId = input.samplingId!;
  const selected = evaluationId === undefined ? null
    : await readOwnedEvaluationResult(c, { projectId, samplingId, runId, evaluationId });
  const view = selected?.view ?? await ownedSampling(c, { projectId, samplingId, runId });
  if (evaluationId !== undefined) {
    const { output, contentHash, hashRedacted, hasParsedDocument, privatePrompts } = selected!;
    const modelResult = ({ chunk, sourceRedacted, streamRequired, display }: JsonChunkResult) => ({
      scope, project: project(view.project), ...runScope,
      projectSample: { projectSampleId: view.projectSample.projectSampleId, dataId: view.projectSample.dataId },
      sampling: { samplingId, status: view.sampling.execution.status },
      evaluationResult: {
        evaluationId, outputStatus: output.outputStatus,
        validation: { status: output.validation.status, reason: output.validation.reason },
        contentHash, sourceRedacted: sourceRedacted || hashRedacted,
        rawJsonChunk: chunk, ...(streamRequired ? { streamRequired, display } : {}),
      },
    });
    const result: JsonChunkResult = hasParsedDocument
      ? jsonChunk(output.rawJson, input.resultOffset ?? 0, privatePrompts,
        (chunk, sourceRedacted) => fitsTaktResult(modelResult({ chunk, sourceRedacted })))
      : { chunk: null, sourceRedacted: false };
    if (result.chunk === null && !result.streamRequired && (input.resultOffset ?? 0) !== 0) {
      throw new HttpError("REQUEST_INVALID_INPUT", "This Evaluation has no result continuation");
    }
    return modelResult(result);
  }
  const evaluationPage = pageOf(view.evaluations, page, pageSize);
  return { scope, project: project(view.project), ...runScope, projectSample: sample(view.projectSample),
    sampling: { samplingId: view.sampling.samplingId, status: view.sampling.execution.status },
    summary: metricSummary(view.summary, page, pageSize, toolPage, toolPageSize),
    evaluations: { ...evaluationPage, items: evaluationPage.items.map(({ record, output }) => ({
      evaluationId: record.evaluationId, status: record.status.status,
      validation: { status: output.validation.status, reason: output.validation.reason },
    })) } };
}
