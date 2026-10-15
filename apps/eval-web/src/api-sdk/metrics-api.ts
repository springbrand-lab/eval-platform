import { api, enc } from "./client";
import type { DatasetOverview, ProjectOverview, SampleOverview, SamplingDetail } from "./types";

export const metricKeys = {
  project: (projectId: string, runIds: readonly string[]) => ["metrics", projectId, "project", ...runIds] as const,
  dataset: (projectId: string, datasetId: string, runIds: readonly string[]) =>
    ["metrics", projectId, "dataset", datasetId, ...runIds] as const,
  sample: (projectId: string, projectSampleId: string, runIds: readonly string[]) =>
    ["metrics", projectId, "sample", projectSampleId, ...runIds] as const,
  sampling: (projectId: string, samplingId: string) => ["metrics", projectId, "sampling", samplingId] as const,
};

const scope = (runIds: readonly string[]) => (runIds.length > 0 ? { params: { runId: runIds } } : {});
const base = (projectId: string) => `/api/metrics/projects/${enc(projectId)}`;

export const getProjectOverview = (projectId: string, runIds: readonly string[] = [], signal?: AbortSignal) =>
  api.get<ProjectOverview>(base(projectId), { ...scope(runIds), signal });
export const getDatasetOverview = (projectId: string, datasetId: string, runIds: readonly string[] = [], signal?: AbortSignal) =>
  api.get<DatasetOverview>(`${base(projectId)}/datasets/${enc(datasetId)}`, { ...scope(runIds), signal });
export const getSampleOverview = (projectId: string, projectSampleId: string, runIds: readonly string[] = [], signal?: AbortSignal) =>
  api.get<SampleOverview>(`${base(projectId)}/samples/${enc(projectSampleId)}`, { ...scope(runIds), signal });
export const getSamplingDetail = (projectId: string, samplingId: string, signal?: AbortSignal) =>
  api.get<SamplingDetail>(`${base(projectId)}/samplings/${enc(samplingId)}`, { signal });
