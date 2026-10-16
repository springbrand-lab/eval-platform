import { api, enc } from "./client";
import type { BundleRecord, MaterialFile, MaterialRecord, SessionRecord } from "./types";

export const bundleKeys = {
  all: ["bundles"] as const,
  list: () => ["bundles", "list"] as const,
  detail: (bundleId: string) => ["bundles", "detail", bundleId] as const,
  materials: (bundleId: string) => ["bundles", "materials", bundleId] as const,
  sessions: (bundleId: string) => ["bundles", "sessions", bundleId] as const,
};

interface Metadata { name: string; description: string }
const base = (bundleId: string) => `/api/bundles/${enc(bundleId)}`;

export const listBundles = (signal?: AbortSignal) => api.get<BundleRecord[]>("/api/bundles", { signal });
export const getBundle = (bundleId: string, signal?: AbortSignal) => api.get<BundleRecord>(base(bundleId), { signal });
export const createBundle = (input: Metadata) => api.post<BundleRecord>("/api/bundles", input);
export const updateBundle = (bundleId: string, input: Partial<Metadata>) => api.patch<BundleRecord>(base(bundleId), input);
export const deleteBundle = (bundleId: string) => api.delete(base(bundleId));
export const listMaterials = (bundleId: string, signal?: AbortSignal) =>
  api.get<MaterialRecord[]>(`${base(bundleId)}/materials`, { signal });
export const createMaterial = (bundleId: string, input: Metadata & { files: readonly MaterialFile[] }) =>
  api.post<MaterialRecord>(`${base(bundleId)}/materials`, input, { timeoutMs: 180_000 });
export const deleteMaterial = (bundleId: string, materialId: string) =>
  api.delete(`${base(bundleId)}/materials/${enc(materialId)}`);
export const listSessions = (bundleId: string, signal?: AbortSignal) =>
  api.get<SessionRecord[]>(`${base(bundleId)}/sessions`, { signal });
export const createSession = (bundleId: string, input: Metadata & { format: "json" | "jsonl"; content: string }) =>
  api.post<SessionRecord>(`${base(bundleId)}/sessions`, input);
export const deleteSession = (bundleId: string, sessionId: string) =>
  api.delete(`${base(bundleId)}/sessions/${enc(sessionId)}`);
