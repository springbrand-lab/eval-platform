import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Download, Pencil, Plus, Trash2, Unlink } from "lucide-react";
import { ActionMenu } from "@/components/ui/menu";
import { useState } from "react";
import { toast } from "sonner";
import {
  attachData, datasetKeys, deleteDataset, detachData, exportDataset, getDataset, listDatasetData, updateDataset,
} from "@/api-sdk/datasets-api";
import type { Data } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { AttachDataDialog } from "./attach-data-dialog";
import { DatasetImportDialog } from "./import-dialogs";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { EmptyState, ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
import { Badge } from "@/components/ui/badge";
import { Field, Input, Textarea } from "@/components/ui/form";
import { downloadText } from "@/lib/files";

export function dataTitle(data: Data): string {
  const name = (data as { name?: unknown }).name;
  if (typeof name === "string" && name.trim()) return name;
  return data.userPrompt.length > 60 ? `${data.userPrompt.slice(0, 60)}…` : data.userPrompt;
}

/** Only what needs attention gets a badge; attached resources are plain text. */
export function DataResourceBadges({ data }: { data: Data }) {
  const resources = [
    data.initialMaterials && "素材",
    data.evalInitialMaterials && "评估 Agent 素材",
    data.initialSession && "初始对话",
  ].filter(Boolean);
  return (
    <span className="flex flex-wrap items-center gap-2 whitespace-nowrap text-xs text-text-muted">
      {!data.evalPrompt && <Badge tone="warning">缺少评估要求</Badge>}
      {resources.join(" · ") || (data.evalPrompt ? "已填写" : "")}
    </span>
  );
}

export function DatasetDetailPage({ datasetId }: { datasetId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const dataset = useQuery({ queryKey: datasetKeys.detail(datasetId), queryFn: ({ signal }) => getDataset(datasetId, signal) });
  const members = useQuery({ queryKey: datasetKeys.members(datasetId), queryFn: ({ signal }) => listDatasetData(datasetId, signal) });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<"edit" | "detach" | "delete" | "attach" | "import" | null>(null);
  const [form, setForm] = useState({ name: "", description: "" });

  const update = useMutation({
    mutationFn: () => updateDataset(datasetId, { name: form.name.trim(), ...(form.description.trim() ? { description: form.description.trim() } : {}) }),
    onSuccess: async () => {
      setDialog(null);
      await queryClient.invalidateQueries({ queryKey: datasetKeys.all });
    },
  });
  const restore = useMutation({ mutationFn: (ids: string[]) => attachData(datasetId, ids),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: datasetKeys.all }); toast.success("已恢复用例关联"); } });
  const detach = useMutation({
    mutationFn: () => detachData(datasetId, [...selected]),
    onSuccess: async () => {
      const ids = [...selected];
      toast.success(`已移出 ${ids.length} 条用例`, { action: { label: "撤销", onClick: () => restore.mutate(ids) } });
      setSelected(new Set());
      setDialog(null);
      await queryClient.invalidateQueries({ queryKey: datasetKeys.all });
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteDataset(datasetId),
    onSuccess: async () => {
      toast.success("已删除数据集");
      await queryClient.invalidateQueries({ queryKey: datasetKeys.all });
      void navigate({ to: "/datasets" });
    },
  });
  const exportAs = async (format: "json" | "yaml") => {
    const text = await exportDataset(datasetId, format);
    downloadText(`${dataset.data?.name ?? "dataset"}.${format === "yaml" ? "yaml" : "json"}`, text,
      format === "yaml" ? "application/yaml" : "application/json");
  };

  return (
    <Page>
      <PageHeader
        title={dataset.data?.name ?? "数据集"}
        description={dataset.data?.description}
        crumbs={[{ label: "数据集", to: "/datasets" }]}
        actions={(
          <>
            <Button icon={<Pencil />} onClick={() => {
              setForm({ name: dataset.data?.name ?? "", description: dataset.data?.description ?? "" });
              setDialog("edit");
            }}>编辑名称</Button>
            <Button variant="primary" disabled={!members.data?.length} onClick={() => void navigate({ to: "/projects/new", search: { datasetId } })}>用此数据集创建项目</Button>
            <Button icon={<Plus />} onClick={() => void navigate({ to: "/datasets/$datasetId/data/new", params: { datasetId } })}>新建用例</Button>
            <ActionMenu items={[
              { label: "导出 JSON", icon: <Download />, onSelect: () => void exportAs("json") },
              { label: "导出 YAML", icon: <Download />, onSelect: () => void exportAs("yaml") },
              { label: "删除数据集", icon: <Trash2 />, danger: true, separated: true, onSelect: () => setDialog("delete") },
            ]} />
          </>
        )}
      />
      {dataset.error && <ErrorBlock error={dataset.error} />}
      <Card>
        <CardHeader
          title={`用例（${members.data?.length ?? 0}）`}
          description="修改用例会影响所有引用它的数据集，已有项目使用创建时的数据副本，不会随之更新。"
          actions={(
            <>
              <Button size="sm" onClick={() => setDialog("import")}>批量导入</Button>
              <Button size="sm" onClick={() => setDialog("attach")}>添加已有用例</Button>
              {selected.size > 0 && (
                <Button size="sm" icon={<Unlink className="size-4" />} onClick={() => setDialog("detach")}>移出 {selected.size} 条</Button>
              )}
            </>
          )}
        />
        {members.isPending ? <LoadingBlock /> : members.error ? <div className="p-4"><ErrorBlock error={members.error} /></div> : (
          <DataTable<Data>
            rows={members.data}
            rowKey={(row) => row.dataId}
            rowLabel={dataTitle}
            selectable
            selected={selected}
            onSelectedChange={setSelected}
            searchText={(row) => `${dataTitle(row)} ${row.description ?? ""} ${row.userPrompt} ${row.evalPrompt ?? ""}`}
            onRowClick={(row) => void navigate({ to: "/data/$dataId", params: { dataId: row.dataId }, search: { datasetId } })}
            empty={<EmptyState title="数据集还没有用例" />}
            columns={[
              { key: "title", header: "名称", className: "min-w-40", cell: (row) => <span className="line-clamp-2 font-semibold text-text-strong">{dataTitle(row)}</span>, sortValue: dataTitle },
              { key: "prompt", header: "执行任务", cell: (row) => <span className="line-clamp-2 max-w-md whitespace-normal text-text-muted">{row.userPrompt}</span> },
              { key: "resources", header: "准备情况", cell: (row) => <DataResourceBadges data={row} /> },
            ]}
          />
        )}
      </Card>
      {dialog === "attach" && <AttachDataDialog datasetId={datasetId} onClose={() => setDialog(null)} />}
      {dialog === "import" && <DatasetImportDialog datasetId={datasetId} onClose={() => setDialog(null)} />}
      <Dialog open={dialog === "edit"} onClose={() => setDialog(null)} size="sm" title="编辑数据集"
        footer={<><Button onClick={() => setDialog(null)}>取消</Button><Button variant="primary" disabled={!form.name.trim()} loading={update.isPending} onClick={() => update.mutate()}>保存</Button></>}>
        <div className="flex flex-col gap-4">
          {update.error && <ErrorBlock error={update.error} />}
          <Field label="名称" required>{(id) => <Input id={id} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />}</Field>
          <Field label="说明">{(id) => <Textarea id={id} rows={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />}</Field>
        </div>
      </Dialog>
      <ConfirmDialog open={dialog === "detach"} onClose={() => setDialog(null)} onConfirm={() => detach.mutate()} loading={detach.isPending}
        title="移出用例" description={`从数据集移出 ${selected.size} 条用例。用例本身不会删除，可通过“添加已有用例”重新加入。已有项目不受影响。`} confirmLabel="移出" />
      <ConfirmDialog open={dialog === "delete"} onClose={() => setDialog(null)} onConfirm={() => remove.mutate()} loading={remove.isPending} danger
        title="删除数据集" description="用例会保留，已有 Project 不受影响。" confirmLabel="删除" />
    </Page>
  );
}
