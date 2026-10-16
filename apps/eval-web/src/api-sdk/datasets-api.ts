import { api, enc } from "./client";
import type { Data, Dataset, DatasetSnapshot } from "./types";

export const datasetKeys = {
  all: ["datasets"] as const,
  list: () => ["datasets", "list"] as const,
  detail: (datasetId: string) => ["datasets", "detail", datasetId] as const,
  members: (datasetId: string) => ["datasets", "members", datasetId] as const,
};

export type DatasetFormat = "json" | "yaml";

export const listDatasets = (signal?: AbortSignal) => api.get<Dataset[]>("/api/datasets", { signal });
export const getDataset = (datasetId: string, signal?: AbortSignal) => api.get<Dataset>(`/api/datasets/${enc(datasetId)}`, { signal });
export const createDataset = (input: { name: string; description?: string }) => api.post<Dataset>("/api/datasets", input);
export const updateDataset = (datasetId: string, input: { name: string; description?: string }) =>
  api.put<Dataset>(`/api/datasets/${enc(datasetId)}`, input);
export const deleteDataset = (datasetId: string) => api.delete(`/api/datasets/${enc(datasetId)}`);
export const listDatasetData = (datasetId: string, signal?: AbortSignal) =>
  api.get<Data[]>(`/api/datasets/${enc(datasetId)}/data`, { signal });
export const attachData = (datasetId: string, dataIds: readonly string[]) =>
  api.post<void>(`/api/datasets/${enc(datasetId)}/data`, { dataIds });
export const detachData = (datasetId: string, dataIds: readonly string[]) =>
  api.delete(`/api/datasets/${enc(datasetId)}/data`, { body: { dataIds } });
export const importDataset = (format: DatasetFormat, content: string) =>
  api.post<DatasetSnapshot>("/api/datasets/import", content, {
    params: { format },
    headers: { "Content-Type": format === "yaml" ? "application/yaml" : "text/plain" },
  });
export const importPromptDataset = (input: { name: string; description: string; format: "json" | "jsonl"; content: string }) =>
  api.post<DatasetSnapshot>("/api/datasets/prompt-import", input);
export const exportDataset = (datasetId: string, format: DatasetFormat) =>
  api.text(`/api/datasets/${enc(datasetId)}/export`, { params: { format } });

export const importDatasetData = (datasetId: string, input: { format: "json" | "jsonl"; content: string }) =>
  api.post<Data[]>(`/api/datasets/${enc(datasetId)}/data/import`, input);
