import type { ProjectComparisonQuery, ProjectComparisonView } from "@eval-platform/eval-metrics";
import { api } from "./client";

export const comparisonKeys = {
  all: ["comparison"] as const,
  view: (query: ProjectComparisonQuery) =>
    ["comparison", [...query.projectIds], query.datasetId ?? null, query.jsonPointer ?? null] as const,
};

export const getProjectComparison = (query: ProjectComparisonQuery, signal?: AbortSignal) =>
  api.get<ProjectComparisonView>("/api/metrics/comparison", {
    params: { projectId: query.projectIds, datasetId: query.datasetId, jsonPointer: query.jsonPointer }, signal,
  });
