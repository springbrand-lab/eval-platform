import { useDatasetCatalog } from "./use-dataset-catalog";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@springbrand/site-block";

import type { Dataset } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Card } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";

import { EmptyState, ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
import { DatasetCreateDialog, DatasetImportDialog } from "./import-dialogs";

export function DatasetsPage() {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const { datasets, members } = useDatasetCatalog();
  const [importing, setImporting] = useState(false);
  return (
    <Page>
      <PageHeader
        title="数据集"
        description="统一创建或导入数据集，管理执行提示词、评估要求与用例。"

        actions={<><Button variant="outline" onClick={() => setImporting(true)}>导入数据集</Button><Button onClick={() => setCreating(true)}><Plus />新建数据集</Button></>}
      />
      <Card>
        {datasets.isPending ? <LoadingBlock /> : datasets.error ? <div className="p-4"><ErrorBlock error={datasets.error} /></div> : (
          <DataTable<Dataset>
            rows={datasets.data}
            rowKey={(row) => row.datasetId}
            searchText={(row) => `${row.name} ${row.description ?? ""}`}
            searchPlaceholder="搜索数据集名称或说明"
            onRowClick={(row) => void navigate({ to: "/datasets/$datasetId", params: { datasetId: row.datasetId } })}
            empty={<EmptyState title="还没有数据集"
              description="使用右上方「新建数据集」，上传用例列表、导入完整数据集，或先创建空数据集。" />}
            columns={[
              { key: "name", header: "名称", cell: (row) => <span className="font-semibold">{row.name}</span>, sortValue: (row) => row.name },
              { key: "description", header: "说明", cell: (row) => <span className="line-clamp-1 text-text-muted">{row.description || "—"}</span> },
              { key: "count", header: "用例", cell: (row) => { const query = members[datasets.data?.findIndex((item) => item.datasetId === row.datasetId) ?? -1]; return query?.error ? "读取失败" : query?.data ? `${query.data.length} 条` : "加载中"; } },
              { key: "ready", header: "准备情况", cell: (row) => { const query = members[datasets.data?.findIndex((item) => item.datasetId === row.datasetId) ?? -1]; return !query?.data ? "—" : !query.data.length ? "待添加用例" : query.data.some((item) => !item.evalPrompt?.trim()) ? "待补充评估要求" : "可创建项目"; } },
            ]}
          />
        )}
      </Card>
      {importing && <DatasetImportDialog onClose={() => setImporting(false)} />}
      {creating && <DatasetCreateDialog onClose={() => setCreating(false)} />}
    </Page>
  );
}
