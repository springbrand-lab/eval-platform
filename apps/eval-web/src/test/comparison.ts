import type {
  ComparisonDataRow, ComparisonField, ComparisonProjectValues, NumericSummary, OutputFieldSummary,
  Dashboard, ProjectComparisonView, Project, ProjectView, SamplingDetail,
} from "@/api-sdk/types";
import { agentMetric, metricSummary, resourceStatistics } from "./metrics";

export const savedDashboardId = "71000000-0000-4000-8000-000000000001";

export function savedDashboard(patch: Partial<Dashboard> = {}): Dashboard {
  return {
    dashboardId: savedDashboardId, name: "质量观察", description: "当前共同已评数据",
    excludedDataIds: [],
    projectIds: ["p1", "p2"], revision: 1, createdAt: "2026-10-28T10:00:00Z", updatedAt: "2026-10-28T10:00:00Z", ...patch,
  };
}

export function comparisonProject(index: number): Project {
  return {
    projectId: `p${index}`, name: `项目 ${index}`, description: `第 ${index} 轮执行配置`,
    ownerUserId: "owner", sourceBranch: "eval", createdAt: "2026-10-28T10:00:00Z",
  };
}

export const comparisonFields: readonly ComparisonField[] = [
  { jsonPointer: "/score", title: "正确性", description: "依据任务要求评估", kinds: ["number"], values: [], nullable: true, dataCount: 24 },
  { jsonPointer: "/passed", title: "是否符合要求", description: null, kinds: ["boolean"], values: [true, false], nullable: false, dataCount: 1 },
];

const numeric = (value: number, count = 1): NumericSummary => ({
  count, missing: 0, mean: value, total: value * count, median: value, min: value, max: value, variance: 0,
});

export function comparisonScore(value: number | boolean, count = 1): OutputFieldSummary {
  const boolean = typeof value === "boolean";
  return {
    jsonPointer: boolean ? "/passed" : "/score", title: boolean ? "是否符合要求" : "正确性",
    description: null, kinds: boolean ? ["boolean"] : ["number"], observationCount: count,
    contributingEvaluationCount: count, missingEvaluationCount: 0, coverage: "complete", diagnostics: [],
    numeric: typeof value === "number" ? numeric(value, count) : null,
    distribution: boolean ? [
      { value: true, count: value ? count : 0, evaluations: value ? count : 0, share: value ? 1 : 0 },
      { value: false, count: value ? 0 : count, evaluations: value ? 0 : count, share: value ? 0 : 1 },
    ] : [],
  };
}

function values(projectId: string, score: number | boolean, dataCount = 1): ComparisonProjectValues {
  return {
    projectId, dataCount, samplingCount: dataCount * 2, evaluationCount: dataCount * 2, score: comparisonScore(score, dataCount * 2),
    resources: {
      chargedUnits: { value: 18, coverage: "complete" },
      chargedUnitsPerAgent: { ...numeric(0.75, dataCount * 2), coverage: "complete" },
      agentDurationMs: numeric(2_000, dataCount * 2),
      cacheHitRate: { value: 0, coverage: "complete" }, toolSuccessRate: { value: null, coverage: "complete" },
    },
  };
}

export function comparisonRow(index: number, boolean = false): ComparisonDataRow {
  const dataId = `data-${index}`;
  return {
    dataId, data: { dataId, name: index === 0 ? "零分用例" : `用例 ${index + 1}`, userPrompt: `任务 ${index + 1}`, evalPrompt: "检查产物" },
    datasetIds: index === 0 ? ["dataset-a", "dataset-b"] : ["dataset-a"],
    inputChanged: index === 0, spread: boolean ? null : index === 0 ? 0 : 3, different: index > 0,
    projects: ["p1", "p2"].map((projectId) => ({
      ...values(projectId, boolean ? false : index === 0 ? 0 : projectId === "p1" ? 3 : 6),
      projectSampleId: `${projectId}-${dataId}`,
      samplingIds: [`${projectId}-${dataId}-valid-a`, `${projectId}-${dataId}-valid-b`],
    })),
  };
}

export function comparisonView(boolean = false): ProjectComparisonView {
  return {
    projects: [1, 2].map((index) => ({
      project: comparisonProject(index), executionAgentName: `执行配置 ${index}`, evaluationAgentName: "统一评估配置",
      framework: "sp", executionModel: index === 1 ? "model-a" : "model-b",
    })),
    fields: comparisonFields, selectedField: comparisonFields[boolean ? 1 : 0], datasetId: null,
    datasets: [{ datasetId: "dataset-a", name: "核心任务", dataCount: boolean ? 1 : 24 }, { datasetId: "dataset-b", name: "边界场景", dataCount: 1 }],
    summary: [values("p1", boolean ? false : 7.25, boolean ? 1 : 24), values("p2", boolean ? false : 8.5, boolean ? 1 : 24)],
    rows: boolean ? [comparisonRow(0, true)] : Array.from({ length: 24 }, (_, index) => comparisonRow(index)),
  };
}

export function comparisonProjectView(projectId: string): ProjectView {
  const project = comparisonProject(Number(projectId.slice(1)));
  return {
    project, datasets: [], projectSamples: [], runSequence: 0, currentRun: null, evaluation: null, executionPlanDigest: "execution",
    execution: {
      harness: { kind: "sp", framework: "sp", agentConfig: { ownerUserId: "owner", userAgentId: "executor" } },
      subjectAgentConfig: { sourceUserAgentId: "executor", name: "执行配置", body: {} },
      executionConcurrency: 2, retryPolicy: { maxRestarts: 0, initialBackoffMs: 100, maxBackoffMs: 1_000 },
    },
  };
}

export function comparisonSampling(projectId: string, samplingId: string): SamplingDetail {
  const resources = resourceStatistics();
  const agent = agentMetric(resources);
  const evaluationId = `${samplingId}-evaluation`;
  const summary = metricSummary(resources, resources);
  return {
    project: comparisonProjectView(projectId).project, runIds: [],
    projectSample: {
      projectId, projectSampleId: `${projectId}-data-0`, dataId: "data-0", datasetIds: ["dataset-a"], samplingCount: 2,
      data: comparisonRow(0).data,
    },
    sampling: {
      samplingId, projectId, projectSampleId: `${projectId}-data-0`, execution: { status: "succeeded" },
      subjectAgent: agent.agentConfigRef, executionAttempts: [],
    },
    summary: { ...summary, evaluationOutputs: { ...summary.evaluationOutputs, fields: [comparisonScore(0)] } },
    subject: { ...agent, samplingId, artifacts: [{ artifactId: `${samplingId}-artifact`, path: "/index.html", kind: "file" }] },
    evaluations: [{
      record: { evaluationId, samplingId, evaluator: agent.agentConfigRef, status: { status: "succeeded" }, attempts: [] },
      agent: { ...agent, role: "evaluator", evaluationId, samplingId },
      output: {
        evaluationId, samplingId, path: "/result.json", contentHash: null, content: null, rawJson: { score: 0, reason: `${samplingId} 的评估理由` },
        outputStatus: "succeeded", outputError: null, validation: { status: "valid", reason: "valid", errors: [] }, observations: [],
        artifacts: [], evidenceRefs: [], trajectory: null,
      },
    }],
  };
}
