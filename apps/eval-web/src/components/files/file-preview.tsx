import { useQuery, type QueryKey } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { Button } from "@springbrand/site-block";
import { fileFormatFor, isBinaryFileFormat } from "@springbrand/file-renderers/format";
import { decodePreviewText, inlinePreviewLimit } from "@springbrand/file-renderers/preview-content";
import { parseFile, type FileRendererProjection } from "@springbrand/file-renderers/preview-host";
import { FileRendererErrorBoundary } from "@springbrand/file-renderers/preview-error-boundary";
import { FileRendererPreview, FileRendererSource, FileRendererTextPreview, FileViewSwitch, type FileViewMode } from "@springbrand/file-renderers/preview-surface";
import type { RendererResourceResolver } from "@springbrand/file-renderers/contracts";
import { ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
import { formatBytes } from "@/lib/format";
import { useBlobUrl } from "@/lib/use-blob-url";
import { fileResources, type ReadPreviewFile } from "./file-resources";

export interface PreviewFile {
  readonly path: string;
  readonly name: string;
  readonly mediaType?: string;
  readonly byteSize?: number;
}

interface ParsedPreview {
  readonly projection: FileRendererProjection | null;
  readonly resources: RendererResourceResolver;
  readonly text: string | null;
  readonly limit: number | null;
}

/** Shared read-only host. Query caches bytes; renderer state and linked-resource work live only with this selection. */
export function FilePreview({ file, queryKey, readFile, refetchInterval = false }: {
  file: PreviewFile; queryKey: QueryKey; readFile: ReadPreviewFile; refetchInterval?: number | false;
}) {
  const request = useQuery({ queryKey, queryFn: ({ signal }) => readFile(file.path, signal), staleTime: 0, refetchInterval });
  const blob = request.data;
  const download = useBlobUrl(request.isSuccess ? blob : undefined);
  const [mode, setMode] = useState<FileViewMode>("preview");
  const input = useMemo(() => ({ blob, path: file.path, name: file.name, mediaType: file.mediaType, readFile }), [blob, file.path, file.name, file.mediaType, readFile]);
  const [state, setState] = useState<({ input: typeof input } & (
    { status: "ready"; preview: ParsedPreview } | { status: "failed"; error: unknown; text: string | null }
  )) | null>(null);
  useEffect(() => {
    if (!input.blob) return;
    const controller = new AbortController();
    const { signal } = controller;
    const resources = fileResources(input.readFile, signal);
    let source: string | null = null;
    async function prepare() {
      const mimeType = input.mediaType || input.blob!.type;
      const format = fileFormatFor({ name: input.name, mimeType });
      const maximum = inlinePreviewLimit(format);
      if (maximum !== null && input.blob!.size > maximum) {
        return { projection: null, resources, text: null, limit: maximum };
      }
      if (format === "unknown") return { projection: null, resources, text: null, limit: null };
      const bytes = new Uint8Array(await input.blob!.arrayBuffer());
      signal.throwIfAborted();
      const text = isBinaryFileFormat(format) ? null : decodePreviewText(bytes);
      source = text;
      const projection = await parseFile({ path: input.path, name: input.name, mimeType, resources, signal,
        payload: text === null ? { encoding: "bytes", content: bytes } : { encoding: "text", content: text, bytes } });
      return { projection, resources, text, limit: null };
    }
    void prepare().then((preview) => { if (!signal.aborted) setState({ input, status: "ready", preview }); },
      (error: unknown) => { if (!signal.aborted) setState({ input, status: "failed", error, text: source }); });
    return () => controller.abort();
  }, [input]);
  const current = state?.input === input ? state : null;
  const preview = current?.status === "ready" ? current.preview : null;
  const failed = request.isError || current?.status === "failed";
  const error = request.isError ? request.error : current?.status === "failed" ? current.error : null;
  const source = request.isSuccess ? (current?.status === "failed" ? current.text : preview?.text ?? null) : null;
  const mimeType = file.mediaType || blob?.type || "未知类型";
  const retry = () => { void request.refetch(); };
  return <section aria-label="文件预览" className="flex min-w-0 flex-1 flex-col gap-3">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0"><h2 className="break-all font-mono text-sm">{file.path}</h2>
        <p className="mt-1 text-xs text-text-muted">{mimeType}{(blob?.size ?? file.byteSize) !== undefined && ` · ${formatBytes(blob?.size ?? file.byteSize!)}`}</p></div>
      <div className="flex items-center gap-2">
        {source !== null && <FileViewSwitch mode={mode} onModeChange={setMode} />}
        {blob && <Button size="sm" variant="ghost" aria-label="重新加载文件" disabled={request.isFetching} onClick={retry}><RefreshCw className="size-3.5" /></Button>}
        {download && <Button asChild size="sm" variant="outline"><a href={download} download={file.name}><Download className="size-3.5" />下载</a></Button>}
      </div>
    </header>
    <div className="min-h-[55dvh] min-w-0 rounded-[var(--radius-card)] border border-border bg-surface">
      {mode === "source" && source !== null ? <FileRendererSource text={source} />
        : failed ? <ErrorBlock error={error} onRetry={retry} /> : !preview ? <LoadingBlock rows={6} /> :
        <FileRendererErrorBoundary key={request.dataUpdatedAt} fallback={(failure) => <ErrorBlock error={failure} onRetry={retry} />}>
          {preview.projection ? <FileRendererPreview projection={preview.projection} resources={preview.resources} />
            : preview.text !== null ? <FileRendererTextPreview text={preview.text} />
            : <p className="p-6 text-sm text-text-muted">{preview.limit === null ? "此文件暂不支持在线预览，可下载查看。" : `文件超过 ${formatBytes(preview.limit)} 的预览上限，可下载查看。`}</p>}
        </FileRendererErrorBoundary>}
    </div>
  </section>;
}
