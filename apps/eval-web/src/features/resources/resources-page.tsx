import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { bundleKeys, createBundle, listBundles } from "@/api-sdk/bundles-api";
import type { BundleRecord } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { CopyId } from "@/components/ui/data-display";
import { EmptyState, ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
import { MetadataDialog } from "./metadata-dialog";

export function ResourcesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const bundles = useQuery({ queryKey: bundleKeys.list(), queryFn: ({ signal }) => listBundles(signal) });
  const create = useMutation({
    mutationFn: createBundle,
    onSuccess: async (bundle) => {
      toast.success("已创建");
      await queryClient.invalidateQueries({ queryKey: bundleKeys.all });
      setCreating(false);
      void navigate({ to: "/resources/$bundleId", params: { bundleId: bundle.bundleId } });
    },
  });
  return (
    <Page>
      <PageHeader
        title="初始资源"
        description="用例开始前放进 Agent 工作区的素材文件，以及预置的对话历史（初始会话）。按 Bundle 分组管理，在用例中绑定。"
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>新建 Bundle</Button>}
      />
      <Card>
        {bundles.isPending ? <LoadingBlock /> : bundles.error ? <div className="p-4"><ErrorBlock error={bundles.error} /></div> : (
          <DataTable<BundleRecord>
            rows={bundles.data}
            rowKey={(row) => row.bundleId}
            searchText={(row) => `${row.name} ${row.description}`}
            onRowClick={(row) => void navigate({ to: "/resources/$bundleId", params: { bundleId: row.bundleId } })}
            empty={<EmptyState title="还没有 Bundle" action={<Button variant="primary" onClick={() => setCreating(true)}>新建 Bundle</Button>} />}
            columns={[
              { key: "name", header: "名称", cell: (row) => <span className="font-semibold">{row.name}</span>, sortValue: (row) => row.name },
              { key: "description", header: "说明", cell: (row) => <span className="text-text-muted">{row.description}</span> },
              { key: "id", header: "ID", cell: (row) => <CopyId value={row.bundleId} /> },
            ]}
          />
        )}
      </Card>
      <MetadataDialog open={creating} onClose={() => setCreating(false)} title="新建 Bundle" submitLabel="创建"
        loading={create.isPending} onSubmit={(value) => create.mutate(value)} />
    </Page>
  );
}
