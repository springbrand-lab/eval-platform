import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { Button, FieldSet } from "@springbrand/site-block";
import { Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { createData, dataKeys, deleteData, getData, updateData, type DataInput } from "@/api-sdk/data-api";
import { datasetKeys, getDataset } from "@/api-sdk/datasets-api";
import type { Data } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { ConfirmDialog } from "@/components/ui/dialog";
import { ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
import { fieldErrors, isWriteOutcomeUnknown } from "@/lib/errors";
import { CatalogWriteFeedback } from "@/features/catalog-write-feedback";
import { useDatasetCatalog } from "./use-dataset-catalog";
import { dataTitle } from "./dataset-detail-page";
import { buildDataInput, createDataDraft, DataDraftFields } from "./data-draft-fields";

type DataFormTarget = { mode: "create"; datasetId: string } | { mode: "edit"; data: Data };

function DataForm({ target, datasetId }: { target: DataFormTarget; datasetId?: string }) {
  const initial = target.mode === "edit" ? target.data : undefined;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [draft, setDraft] = useState(() => createDataDraft(initial));
  const catalog = useDatasetCatalog();
  const references = initial ? catalog.references(initial.dataId) : [];
  const allowNavigation = useRef(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(createDataDraft(initial));
  const [deleting, setDeleting] = useState(false);
  const input = buildDataInput(draft);
  const save = useMutation({
    mutationFn: (value: DataInput) => target.mode === "edit"
      ? updateData(target.data.dataId, value)
      : createData(value, { datasetId: target.datasetId }),
    meta: { silent: true },
    onError: async (error) => {
      if (isWriteOutcomeUnknown(error)) await Promise.all([
        queryClient.invalidateQueries({ queryKey: dataKeys.all }),
        queryClient.invalidateQueries({ queryKey: datasetKeys.all }),
      ]);
    },
    onSuccess: async () => {
      allowNavigation.current = true;
      toast.success(initial ? "已保存" : "已创建用例");
      await queryClient.invalidateQueries({ queryKey: dataKeys.all });
      await queryClient.invalidateQueries({ queryKey: datasetKeys.all });
      const destination = target.mode === "create" ? target.datasetId : datasetId;
      if (destination) void navigate({ to: "/datasets/$datasetId", params: { datasetId: destination } });
      else void navigate({ to: "/datasets" });
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteData(initial!.dataId),
    onSuccess: async () => {
      allowNavigation.current = true;
      toast.success("已删除用例");
      await queryClient.invalidateQueries({ queryKey: dataKeys.all });
      void navigate({ to: "/datasets" });
    },
  });
  const blocker = useBlocker({ shouldBlockFn: () => !allowNavigation.current, disabled: !dirty && !save.isPending,
    enableBeforeUnload: dirty || save.isPending, withResolver: true });
  const errors = fieldErrors(save.error);
  const unconfirmedCreate = !initial && isWriteOutcomeUnknown(save.error);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-muted">已有项目使用创建时的数据副本，修改不会更新已有项目。</p>
      {initial && <section className="rounded-lg border border-border p-4 text-sm" aria-label="用例引用关系">
        <p className="mb-2 font-medium">所属数据集 · 保存将更新以下数据集中的同一用例</p>
        {catalog.pending ? <LoadingBlock rows={1} /> : catalog.error ? <ErrorBlock error={catalog.error} /> : references.length ? <ul className="flex flex-wrap gap-3">{references.map((item) => <li key={item.datasetId}><Link className="link" to="/datasets/$datasetId" params={{ datasetId: item.datasetId }}>{item.name}</Link></li>)}</ul> : <p>未归入数据集。可在任意数据集的“添加已有用例”中找到。</p>}
      </section>}
      <FieldSet disabled={save.isPending || unconfirmedCreate} className="min-w-0 gap-4">
      <DataDraftFields draft={draft} onChange={setDraft} errors={errors} />
      </FieldSet>
      {typeof input === "string" && <p className="text-[13px] text-danger">{input}</p>}
      {initial ? save.error && <ErrorBlock error={save.error} /> : <CatalogWriteFeedback error={save.error} />}
      {unconfirmedCreate && target.mode === "create" && <Button asChild variant="outline">
        <Link to="/datasets/$datasetId" params={{ datasetId: target.datasetId }}>返回数据集核对用例</Link>
      </Button>}
      <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-bg/90 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:-mx-6 sm:px-6">
        {initial ? <Button variant="destructive" disabled={save.isPending} onClick={() => setDeleting(true)}><Trash2 />删除用例</Button> : <span />}
        <div className="flex gap-2"><Button variant="outline" disabled={save.isPending} onClick={() => { const id = target.mode === "create" ? target.datasetId : datasetId; if (id) void navigate({ to: "/datasets/$datasetId", params: { datasetId: id } }); else void navigate({ to: "/datasets" }); }}>返回</Button>
        <Button disabled={typeof input === "string" || unconfirmedCreate} loading={save.isPending} onClick={() => { if (typeof input !== "string") save.mutate(input); }}>{initial ? "保存并返回" : "创建用例"}</Button></div>
      </div>
      <ConfirmDialog open={deleting} onClose={() => setDeleting(false)} onConfirm={() => { if (!catalog.pending && !catalog.error && !references.length) remove.mutate(); }} loading={remove.isPending} disabled={catalog.pending || !!catalog.error || references.length > 0} danger
        title="删除用例" description={<>{references.length ? <>请先从以下数据集移出：{references.map((item) => <Link key={item.datasetId} className="link mx-1" to="/datasets/$datasetId" params={{ datasetId: item.datasetId }}>{item.name}</Link>)}</> : catalog.pending ? "正在检查引用关系…" : catalog.error ? "引用关系读取失败，请关闭后重试。" : "已有项目不受影响。"}{remove.error && <ErrorBlock error={remove.error} />}</>} confirmLabel="删除" />
      <ConfirmDialog open={blocker.status === "blocked"} onClose={() => blocker.reset?.()} onConfirm={() => blocker.proceed?.()}
        disabled={save.isPending} title="放弃未保存的修改？" description="离开后，本次未保存的内容将丢失。" confirmLabel="放弃修改" />
    </div>
  );
}

export function NewDataPage({ datasetId }: { datasetId: string }) {
  const dataset = useQuery({ queryKey: datasetKeys.detail(datasetId), queryFn: ({ signal }) => getDataset(datasetId, signal) });
  return <Page>
    <PageHeader title="新建用例" crumbs={[{ label: "数据集", to: "/datasets" }, { label: dataset.data?.name ?? "数据集详情", to: "/datasets/$datasetId", params: { datasetId } }]} />
    <DataForm key={datasetId} target={{ mode: "create", datasetId }} />
  </Page>;
}

export function DataEditorPage({ dataId, datasetId }: { dataId: string; datasetId?: string }) {
  const dataset = useQuery({ queryKey: datasetKeys.detail(datasetId ?? ""), queryFn: ({ signal }) => getDataset(datasetId!, signal), enabled: !!datasetId });
  const data = useQuery({ queryKey: dataKeys.detail(dataId), queryFn: ({ signal }) => getData(dataId, signal) });
  return (
    <Page>
      <PageHeader title={data.data ? dataTitle(data.data) : "用例"} crumbs={[{ label: "数据集", to: "/datasets" }, ...(datasetId ? [{ label: dataset.data?.name ?? "返回所属数据集", to: "/datasets/$datasetId", params: { datasetId } }] : [])]} />
      {data.data ? <>
        {data.error && <ErrorBlock error={data.error} onRetry={() => void data.refetch()} />}
        <DataForm key={dataId} target={{ mode: "edit", data: data.data }} datasetId={datasetId} />
      </> : data.isPending ? <LoadingBlock /> : <ErrorBlock error={data.error} />}
    </Page>
  );
}
