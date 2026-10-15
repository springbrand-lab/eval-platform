import { api, enc } from "./client";
import type { Data } from "./types";

export const dataKeys = {
  all: ["data"] as const,
  list: (datasetId?: string) => ["data", "list", datasetId ?? "all"] as const,
  detail: (dataId: string) => ["data", "detail", dataId] as const,
};

export type DataInput = Omit<Data, "dataId">;
export interface ResourceRef { readonly bundleId: string; readonly materialId: string }
export interface SessionRef { readonly bundleId: string; readonly sessionId: string }
export interface InitialResourcesPatch {
  readonly initialMaterials?: ResourceRef | null;
  readonly evalInitialMaterials?: ResourceRef | null;
  readonly initialSession?: SessionRef | null;
}

export const listData = (datasetId?: string, signal?: AbortSignal) =>
  api.get<Data[]>("/api/data", { params: datasetId ? { datasetId } : {}, signal });
export const getData = (dataId: string, signal?: AbortSignal) => api.get<Data>(`/api/data/${enc(dataId)}`, { signal });
export const createData = (input: DataInput) => api.post<Data>("/api/data", input);
export const updateData = (dataId: string, input: DataInput) => api.put<Data>(`/api/data/${enc(dataId)}`, input);
export const deleteData = (dataId: string) => api.delete(`/api/data/${enc(dataId)}`);
export const patchInitialResources = (dataId: string, patch: InitialResourcesPatch) =>
  api.patch<Data>(`/api/data/${enc(dataId)}/initial-resources`, patch);
