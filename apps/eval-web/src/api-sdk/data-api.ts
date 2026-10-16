import { api, enc } from "./client";
import type { Data } from "./types";
import type { DataCreateOptions, DataInput } from "@eval-platform/eval-dataset";

export const dataKeys = {
  all: ["data"] as const,
  list: (datasetId?: string) => ["data", "list", datasetId ?? "all"] as const,
  detail: (dataId: string) => ["data", "detail", dataId] as const,
};

export type { DataInput };

export const listData = (datasetId?: string, signal?: AbortSignal) =>
  api.get<Data[]>("/api/data", { params: datasetId ? { datasetId } : {}, signal });
export const getData = (dataId: string, signal?: AbortSignal) => api.get<Data>(`/api/data/${enc(dataId)}`, { signal });
export const createData = (input: DataInput, options: DataCreateOptions = {}) => api.post<Data>("/api/data", input, { params: options });
export const updateData = (dataId: string, input: DataInput) => api.put<Data>(`/api/data/${enc(dataId)}`, input);
export const deleteData = (dataId: string) => api.delete(`/api/data/${enc(dataId)}`);
