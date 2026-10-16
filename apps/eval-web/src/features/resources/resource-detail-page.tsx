import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { resourceCatalog, type ResourceKind } from "@/api-sdk/bundles-api";
import { Page, PageHeader } from "@/components/layout/page";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState, ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
import { FileTree } from "@/components/files/file-tree";
import { FilePreview } from "@/components/files/file-preview";
import { resourceFileTree } from "./resource-file-tree";

export function ResourceDetailPage({ kind, bundleId, resourceId }: { kind: ResourceKind; bundleId: string; resourceId: string }) {
  const catalog = resourceCatalog(kind);
  const label = kind === "material" ? "素材" : "上下文";
  const bundle = useQuery({ queryKey: catalog.keys.detail(bundleId), queryFn: ({ signal }) => catalog.get(bundleId, signal) });
  const resource = useQuery({ queryKey: catalog.keys.resource(bundleId, resourceId), queryFn: async ({ signal }) => await catalog.getResource(bundleId, resourceId, signal) });
  const files = useQuery({ queryKey: catalog.keys.files(bundleId, resourceId), queryFn: ({ signal }) => catalog.listFiles(bundleId, resourceId, signal) });
  const tree = useMemo(() => resourceFileTree(files.data ?? []), [files.data]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const selected = files.data?.find((file) => file.path === selectedPath) ?? (files.data?.length === 1 ? files.data[0] : undefined);
  const readFile = useCallback((path: string, signal: AbortSignal) => catalog.getFile(bundleId, resourceId, path, signal), [catalog, bundleId, resourceId]);
  const failed = [bundle, resource, files].find((query) => query.error);
  return <Page>
    <PageHeader title={resource.data?.name ?? `初始${label}`} description={resource.data?.description}
      crumbs={[{ label: "数据集", to: "/datasets" }, { label: `初始${label}`, to: "/resources/$kind", params: { kind } },
        { label: bundle.data?.name ?? `${label}包`, to: "/resources/$kind/$bundleId", params: { kind, bundleId } }]} />
    {failed ? <ErrorBlock error={failed.error} onRetry={() => void failed.refetch()} />
      : !bundle.data || !resource.data || !files.data ? <LoadingBlock />
      : files.data.length === 0 ? <EmptyState title="资源中没有文件" />
      : <div className="grid min-w-0 grid-cols-1 items-start gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <Card><CardHeader title={`目录（${files.data.length} 个文件）`} />
          <div className="max-h-[65dvh] min-h-0 overflow-y-auto overscroll-contain py-2">
            <FileTree label={`${label}目录`} nodes={tree} selectedPath={selected?.path ?? null} onSelect={setSelectedPath} />
          </div>
        </Card>
        {selected ? <FilePreview key={JSON.stringify([kind, bundleId, resourceId, selected.path])}
          file={{ ...selected, name: selected.path.split("/").at(-1)! }} queryKey={catalog.keys.file(bundleId, resourceId, selected.path)} readFile={readFile} />
          : <EmptyState title="选择文件查看内容" description="点击目录中的文件，可预览内容或下载原文件。" />}
      </div>}
  </Page>;
}
