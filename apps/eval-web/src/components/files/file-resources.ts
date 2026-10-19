import type { RendererResourceResolver } from "@springbrand/file-renderers/contracts";
import { rendererResourcePath } from "@springbrand/file-renderers/resource-path";
import { ApiError } from "@/api-sdk/client";

export type ReadPreviewFile = (path: string, signal: AbortSignal) => Promise<Blob>;

/** The reader is already bound to one catalog resource or observed Chat, never a browser origin URL. */
export function fileResources(readFile: ReadPreviewFile, lifetime: AbortSignal): RendererResourceResolver {
  return {
    async resolve(request, { signal, maxBytes }) {
      const active = AbortSignal.any([lifetime, signal]);
      active.throwIfAborted();
      if (request.purpose === "navigate") return { status: "blocked", reason: "请通过目录选择文件" };
      const path = rendererResourcePath(request);
      if (path === null) return { status: "blocked", reason: "链接不在当前资源目录内" };
      try {
        const blob = await readFile(path, active);
        // The preview's remaining byte budget: skip copying a file that cannot fit.
        if (maxBytes !== undefined && blob.size > maxBytes) return { status: "blocked", reason: "文件超过预览大小上限" };
        const content = new Uint8Array(await blob.arrayBuffer());
        active.throwIfAborted();
        return { status: "resolved", resource: { kind: "bytes", content, mimeType: blob.type || "application/octet-stream" } };
      } catch (error) {
        active.throwIfAborted();
        if (error instanceof ApiError && error.status === 404) return { status: "missing", reason: "文件不存在" };
        throw error;
      }
    },
  };
}
