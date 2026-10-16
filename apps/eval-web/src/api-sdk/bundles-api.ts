import { api, enc } from "./client";
import type { InitialResourceFile } from "@eval-platform/eval-contracts";
import type { BundleRecord, MaterialFile, MaterialRecord, SessionRecord } from "./types";

export type ResourceKind = "material" | "session";
export interface Metadata { name: string; description: string }
interface BundleImport { readonly bundle: BundleRecord; readonly imported: readonly { readonly source: string }[] }

/** Both real catalogs share the transport shape, but never share identities, paths or query keys. */
function catalog<R, Input>(kind: ResourceKind, segment: "materials" | "sessions") {
  const path = kind === "material" ? "/api/material-bundles" : "/api/session-bundles";
  const base = (bundleId: string) => `${path}/${enc(bundleId)}`;
  const resources = (bundleId: string) => `${base(bundleId)}/${segment}`;
  const resource = (bundleId: string, resourceId: string) => `${resources(bundleId)}/${enc(resourceId)}`;
  const keys = {
    all: ["bundles", kind] as const,
    list: () => ["bundles", kind, "list"] as const,
    detail: (id: string) => ["bundles", kind, id] as const,
    resources: (id: string) => ["bundles", kind, id, segment] as const,
    resource: (id: string, resourceId: string) => ["bundles", kind, id, segment, resourceId] as const,
    files: (id: string, resourceId: string) => ["bundles", kind, id, segment, resourceId, "files"] as const,
    file: (id: string, resourceId: string, filePath: string) => ["bundles", kind, id, segment, resourceId, "file", filePath] as const,
  };
  return {
    keys,
    list: (signal?: AbortSignal) => api.get<BundleRecord[]>(path, { signal }),
    get: (id: string, signal?: AbortSignal) => api.get<BundleRecord>(base(id), { signal }),
    create: (input: Metadata & { zip?: File }) => {
      const body = new FormData();
      body.set("name", input.name); body.set("description", input.description);
      if (input.zip) body.set("zip", input.zip);
      return api.post<BundleImport>(path, body, { timeoutMs: 180_000 });
    },
    importZip: (id: string, zip: File) => {
      const body = new FormData(); body.set("zip", zip);
      return api.post<BundleImport>(`${base(id)}/import`, body, { timeoutMs: 180_000 });
    },
    update: (id: string, input: Partial<Metadata>) => api.patch<BundleRecord>(base(id), input),
    delete: (id: string) => api.delete(base(id)),
    listResources: (id: string, signal?: AbortSignal) => api.get<R[]>(resources(id), { signal }),
    getResource: (id: string, resourceId: string, signal?: AbortSignal) => api.get<R>(resource(id, resourceId), { signal }),
    listFiles: (id: string, resourceId: string, signal?: AbortSignal) => api.get<InitialResourceFile[]>(`${resource(id, resourceId)}/files`, { signal }),
    getFile: (id: string, resourceId: string, filePath: string, signal?: AbortSignal) =>
      api.blob(`${resource(id, resourceId)}/file`, { params: { path: filePath }, signal, timeoutMs: 120_000 }),
    createResource: (id: string, input: Input) => api.post<R>(resources(id), input, { timeoutMs: 180_000 }),
    updateResource: (id: string, resourceId: string, input: Partial<Metadata>) => api.patch<R>(resource(id, resourceId), input),
    deleteResource: (id: string, resourceId: string) => api.delete(resource(id, resourceId)),
  };
}

export const materialBundles = catalog<MaterialRecord, Metadata & { files: readonly MaterialFile[] }>("material", "materials");
export const sessionBundles = catalog<SessionRecord, Metadata & { format: "json" | "jsonl"; content: string }>("session", "sessions");
export const resourceCatalog = (kind: ResourceKind) => kind === "material" ? materialBundles : sessionBundles;
