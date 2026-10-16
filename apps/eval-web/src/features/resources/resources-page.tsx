import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { resourceCatalog, type ResourceKind } from "@/api-sdk/bundles-api";
import type { BundleRecord } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { CopyId } from "@/components/ui/data-display";
import { EmptyState, ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
import { FileDropzone } from "@/components/ui/file-dropzone";
import { MetadataDialog } from "./metadata-dialog";
import { useInputLimits } from "@/features/input-limits";
import { isWriteOutcomeUnknown } from "@/lib/errors";
import { CatalogWriteFeedback } from "@/features/catalog-write-feedback";

export const RESOURCE_LABELS = { material: "初始素材", session: "初始上下文" } as const;

export function ResourcesPage({ kind }: { kind: ResourceKind }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const catalog = resourceCatalog(kind);
  const label = RESOURCE_LABELS[kind];
  const [creating, setCreating] = useState(false);
  const [zip, setZip] = useState<File | null>(null);
  const [extracting, setExtracting] = useState(false);
  const limits = useInputLimits();
  const zipTooLarge = !!zip && !!limits.data && zip.size > limits.data.zipArchiveBytes;
  const bundles = useQuery({ queryKey: catalog.keys.list(), queryFn: ({ signal }) => catalog.list(signal) });
  const create = useMutation({
    mutationFn: (metadata: { name: string; description: string }) => catalog.create({ ...metadata, ...(zip ? { zip } : {}) }),
    meta: { silent: true },
    onError: async (error) => { if (isWriteOutcomeUnknown(error)) await queryClient.invalidateQueries({ queryKey: catalog.keys.all }); },
    onSuccess: async ({ bundle, imported }) => {
      toast.success(`已创建${label}包，共 ${imported.length} 条`);
      await queryClient.invalidateQueries({ queryKey: catalog.keys.all });
      setCreating(false); setZip(null);
      void navigate({ to: "/resources/$kind/$bundleId", params: { kind, bundleId: bundle.bundleId } });
    },
  });
  const close = () => { if (!create.isPending) { setCreating(false); setZip(null); create.reset(); } };
  return <Page>
    <PageHeader title={label} crumbs={[{ label: "数据集", to: "/datasets" }]}
      description={kind === "material" ? "创建素材包后上传文件或文件夹，也可以在创建时一次导入 ZIP。素材可复用于多个用例。" : "上传执行前的会话上下文。创建时可通过 ZIP 批量导入 JSON / JSONL 文件。"}
      actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>新建{label}包</Button>} />
    <Card>
      {bundles.isPending ? <LoadingBlock /> : bundles.error ? <ErrorBlock error={bundles.error} onRetry={() => void bundles.refetch()} /> : <DataTable<BundleRecord>
        rows={bundles.data} rowKey={(row) => row.bundleId} searchText={(row) => `${row.name} ${row.description}`}
        onRowClick={(row) => void navigate({ to: "/resources/$kind/$bundleId", params: { kind, bundleId: row.bundleId } })}
        empty={<EmptyState title={`还没有${label}包`} description="先创建一个包来组织资源，可同时选择 ZIP 导入，也可进入包后逐条添加。" action={<Button variant="primary" onClick={() => setCreating(true)}>新建{label}包</Button>} />}
        columns={[
          { key: "name", header: "名称", cell: (row) => <span className="font-semibold">{row.name}</span>, sortValue: (row) => row.name },
          { key: "description", header: "说明", cell: (row) => row.description },
          { key: "id", header: "ID", cell: (row) => <CopyId value={row.bundleId} /> },
        ]} />}
    </Card>
    <MetadataDialog open={creating} onClose={close} title={`新建${label}包`} submitLabel="创建" loading={create.isPending} extraValid={!!limits.data && !extracting && !zipTooLarge && !isWriteOutcomeUnknown(create.error)} onSubmit={(value) => create.mutate(value)}>
      {limits.error && <ErrorBlock error={limits.error} onRetry={() => void limits.refetch()} />}
      <FileDropzone disabled={create.isPending} onExtractingChange={setExtracting} multiple={false} accept={{ "application/zip": [".zip"] }} onRejected={() => setZip(null)} maxBytes={limits.data?.zipArchiveBytes} onFiles={(files) => setZip(files[0]?.file ?? null)}
        hint={kind === "material" ? "可选 ZIP：每个顶层目录是一条素材，根目录文件各是一条素材" : "可选 ZIP：根目录每个 JSON / JSONL 文件是一条上下文"} />
      {zip && <p className="text-sm">{zip.name} <Button size="sm" onClick={() => setZip(null)}>移除</Button></p>}
      <CatalogWriteFeedback error={create.error} />
    </MetadataDialog>
  </Page>;
}
