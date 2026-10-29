import type { ProjectComparisonQuery, ProjectComparisonView } from "@eval-platform/eval-metrics";
import { api } from "./client";

export const comparisonKeys = {
  all: ["comparison"] as const,
  view: (query: ProjectComparisonQuery) =>
    ["comparison", [...query.projectIds], query.datasetId ?? null, query.jsonPointer ?? null,
      ...(query.excludedDataIds?.length ? [[...query.excludedDataIds].sort()] : [])] as const,
};

export const getProjectComparison = (query: ProjectComparisonQuery, signal?: AbortSignal) =>
  query.excludedDataIds?.length ? api.post<ProjectComparisonView>("/api/metrics/comparison", query, { signal }) : api.get<ProjectComparisonView>("/api/metrics/comparison", {
    params: { projectId: query.projectIds, datasetId: query.datasetId, jsonPointer: query.jsonPointer }, signal,
  });
