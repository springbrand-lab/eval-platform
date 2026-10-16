import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@springbrand/site-block";
import { datasetKeys, listDatasets } from "@/api-sdk/datasets-api";
import type { Dataset } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Card } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { CopyId } from "@/components/ui/data-display";
import { EmptyState, ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
import { DatasetCreateDialog } from "./import-dialogs";

export function DatasetsPage() {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const datasets = useQuery({ queryKey: datasetKeys.list(), queryFn: ({ signal }) => listDatasets(signal) });
  return (
    <Page>
      <PageHeader
        title="Prompt 数据集"
        description="统一创建或导入测试集，管理执行提示词、评估要求与用例。"
        crumbs={[{ label: "数据集", to: "/datasets" }]}
        actions={<Button onClick={() => setCreating(true)}><Plus />新建数据集</Button>}
      />
      <Card>
        {datasets.isPending ? <LoadingBlock /> : datasets.error ? <div className="p-4"><ErrorBlock error={datasets.error} /></div> : (
          <DataTable<Dataset>
            rows={datasets.data}
            rowKey={(row) => row.datasetId}
            searchText={(row) => `${row.name} ${row.description ?? ""}`}
            searchPlaceholder="搜索测试集名称或说明"
            onRowClick={(row) => void navigate({ to: "/datasets/$datasetId", params: { datasetId: row.datasetId } })}
            empty={<EmptyState title="还没有测试集"
              description="使用右上方「新建数据集」，上传用例列表、导入完整测试集，或先创建空测试集。" />}
            columns={[
              { key: "name", header: "名称", cell: (row) => <span className="font-semibold">{row.name}</span>, sortValue: (row) => row.name },
              { key: "description", header: "说明", cell: (row) => <span className="line-clamp-1 text-text-muted">{row.description || "—"}</span> },
              { key: "id", header: "ID", cell: (row) => <CopyId value={row.datasetId} /> },
            ]}
          />
        )}
      </Card>
      {creating && <DatasetCreateDialog onClose={() => setCreating(false)} />}
    </Page>
  );
}
