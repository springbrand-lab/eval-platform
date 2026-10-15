import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Download, Link2, Pencil, Plus, Trash2, Unlink } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { dataKeys, listData } from "@/api-sdk/data-api";
import {
  attachData, datasetKeys, deleteDataset, detachData, exportDataset, getDataset, listDatasetData, updateDataset,
} from "@/api-sdk/datasets-api";
import type { Data } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { CopyId } from "@/components/ui/data-display";
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

export function DataResourceBadges({ data }: { data: Data }) {
  return (
    <span className="flex flex-wrap gap-1">
      {data.evalPrompt ? <Badge tone="primary">有评审要求</Badge> : <Badge>无评审要求</Badge>}
      {data.initialMaterials && <Badge tone="info">素材</Badge>}
      {data.evalInitialMaterials && <Badge tone="info">评委素材</Badge>}
      {data.initialSession && <Badge tone="info">初始会话</Badge>}
    </span>
  );
}

function AttachDialog({ datasetId, memberIds, open, onClose }: {
  datasetId: string; memberIds: ReadonlySet<string>; open: boolean; onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const all = useQuery({ queryKey: dataKeys.list(), queryFn: ({ signal }) => listData(undefined, signal), enabled: open });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const candidates = useMemo(() => (all.data ?? []).filter((item) => !memberIds.has(item.dataId)), [all.data, memberIds]);
  const attach = useMutation({
    mutationFn: () => attachData(datasetId, [...selected]),
    onSuccess: async () => {
      toast.success(`已加入 ${selected.size} 条用例`);
      setSelected(new Set());
      await queryClient.invalidateQueries({ queryKey: datasetKeys.members(datasetId) });
      onClose();
    },
  });
  return (
    <Dialog open={open} onClose={onClose} size="lg" title="加入已有用例"
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={selected.size === 0} loading={attach.isPending} onClick={() => attach.mutate()}>加入 {selected.size || ""} 条</Button></>}>
      {all.isPending ? <LoadingBlock /> : (
        <DataTable<Data>
          rows={candidates}
          rowKey={(row) => row.dataId}
          selectable
          selected={selected}
          onSelectedChange={setSelected}
          searchText={(row) => `${dataTitle(row)} ${row.userPrompt}`}
          empty={<EmptyState title="没有可加入的用例" />}
          columns={[
            { key: "title", header: "用例", cell: (row) => <span className="line-clamp-2">{dataTitle(row)}</span> },
            { key: "resources", header: "", cell: (row) => <DataResourceBadges data={row} /> },
          ]}
        />
      )}
    </Dialog>
  );
}

export function DatasetDetailPage({ datasetId }: { datasetId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const dataset = useQuery({ queryKey: datasetKeys.detail(datasetId), queryFn: ({ signal }) => getDataset(datasetId, signal) });
  const members = useQuery({ queryKey: datasetKeys.members(datasetId), queryFn: ({ signal }) => listDatasetData(datasetId, signal) });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<"edit" | "attach" | "detach" | "delete" | null>(null);
  const [form, setForm] = useState({ name: "", description: "" });
  const memberIds = useMemo(() => new Set((members.data ?? []).map((item) => item.dataId)), [members.data]);

  const update = useMutation({
    mutationFn: () => updateDataset(datasetId, { name: form.name.trim(), ...(form.description.trim() ? { description: form.description.trim() } : {}) }),
    onSuccess: async () => {
      setDialog(null);
      await queryClient.invalidateQueries({ queryKey: datasetKeys.all });
    },
  });
  const detach = useMutation({
    mutationFn: () => detachData(datasetId, [...selected]),
    onSuccess: async () => {
      toast.success(`已移出 ${selected.size} 条用例`);
      setSelected(new Set());
      setDialog(null);
      await queryClient.invalidateQueries({ queryKey: datasetKeys.members(datasetId) });
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteDataset(datasetId),
    onSuccess: async () => {
      toast.success("已删除测试集");
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
        title={dataset.data?.name ?? "测试集"}
        description={dataset.data?.description}
        crumbs={[{ label: "测试集", to: "/datasets" }]}
        actions={(
          <>
            <Button icon={<Download className="size-4" />} onClick={() => void exportAs("json")}>导出 JSON</Button>
            <Button icon={<Download className="size-4" />} onClick={() => void exportAs("yaml")}>导出 YAML</Button>
            <Button icon={<Pencil className="size-4" />} onClick={() => {
              setForm({ name: dataset.data?.name ?? "", description: dataset.data?.description ?? "" });
              setDialog("edit");
            }}>编辑</Button>
            <Button variant="ghost" className="text-danger" icon={<Trash2 className="size-4" />} onClick={() => setDialog("delete")}>删除</Button>
          </>
        )}
      />
      {dataset.error && <ErrorBlock error={dataset.error} />}
      <Card>
        <CardHeader
          title={`用例（${members.data?.length ?? 0}）`}
          actions={(
            <>
              {selected.size > 0 && (
                <Button size="sm" icon={<Unlink className="size-4" />} onClick={() => setDialog("detach")}>移出 {selected.size} 条</Button>
              )}
              <Button size="sm" icon={<Link2 className="size-4" />} onClick={() => setDialog("attach")}>加入已有用例</Button>
              <Button size="sm" variant="primary" icon={<Plus className="size-4" />}
                onClick={() => void navigate({ to: "/data/new", search: { datasetId } })}>新建用例</Button>
            </>
          )}
        />
        {members.isPending ? <LoadingBlock /> : members.error ? <div className="p-4"><ErrorBlock error={members.error} /></div> : (
          <DataTable<Data>
            rows={members.data}
            rowKey={(row) => row.dataId}
            selectable
            selected={selected}
            onSelectedChange={setSelected}
            searchText={(row) => `${dataTitle(row)} ${row.userPrompt} ${row.evalPrompt ?? ""}`}
            onRowClick={(row) => void navigate({ to: "/data/$dataId", params: { dataId: row.dataId } })}
            empty={<EmptyState title="测试集还没有用例" />}
            columns={[
              { key: "title", header: "用例", cell: (row) => <span className="line-clamp-2 font-medium">{dataTitle(row)}</span>, sortValue: dataTitle },
              { key: "prompt", header: "userPrompt", cell: (row) => <span className="line-clamp-2 text-text-muted">{row.userPrompt}</span> },
              { key: "resources", header: "", cell: (row) => <DataResourceBadges data={row} /> },
              { key: "id", header: "ID", cell: (row) => <CopyId value={row.dataId} /> },
            ]}
          />
        )}
      </Card>
      <Dialog open={dialog === "edit"} onClose={() => setDialog(null)} size="sm" title="编辑测试集"
        footer={<><Button onClick={() => setDialog(null)}>取消</Button><Button variant="primary" disabled={!form.name.trim()} loading={update.isPending} onClick={() => update.mutate()}>保存</Button></>}>
        <div className="flex flex-col gap-4">
          <Field label="名称" required>{(id) => <Input id={id} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />}</Field>
          <Field label="说明">{(id) => <Textarea id={id} rows={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />}</Field>
        </div>
      </Dialog>
      <AttachDialog datasetId={datasetId} memberIds={memberIds} open={dialog === "attach"} onClose={() => setDialog(null)} />
      <ConfirmDialog open={dialog === "detach"} onClose={() => setDialog(null)} onConfirm={() => detach.mutate()} loading={detach.isPending}
        title="移出用例" description={`从测试集移出 ${selected.size} 条用例。用例本身不会删除，已有 Project 不受影响。`} confirmLabel="移出" />
      <ConfirmDialog open={dialog === "delete"} onClose={() => setDialog(null)} onConfirm={() => remove.mutate()} loading={remove.isPending} danger
        title="删除测试集" description="测试集会被删除，其中的用例保留。已创建的 Project 使用的是创建时的副本，不受影响。" confirmLabel="删除" />
    </Page>
  );
}
