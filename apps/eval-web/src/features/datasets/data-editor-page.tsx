import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Button, FieldSet } from "@springbrand/site-block";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { createData, dataKeys, deleteData, getData, updateData, type DataInput } from "@/api-sdk/data-api";
import { datasetKeys } from "@/api-sdk/datasets-api";
import type { Data } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { ConfirmDialog } from "@/components/ui/dialog";
import { ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
import { fieldErrors, isWriteOutcomeUnknown } from "@/lib/errors";
import { CatalogWriteFeedback } from "@/features/catalog-write-feedback";
import { dataTitle } from "./dataset-detail-page";
import { buildDataInput, createDataDraft, DataDraftFields } from "./data-draft-fields";

type DataFormTarget = { mode: "create"; datasetId: string } | { mode: "edit"; data: Data };

function DataForm({ target }: { target: DataFormTarget }) {
  const initial = target.mode === "edit" ? target.data : undefined;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [draft, setDraft] = useState(() => createDataDraft(initial));
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
      toast.success(initial ? "已保存" : "已创建用例");
      await queryClient.invalidateQueries({ queryKey: dataKeys.all });
      await queryClient.invalidateQueries({ queryKey: datasetKeys.all });
      if (target.mode === "create") {
        void navigate({ to: "/datasets/$datasetId", params: { datasetId: target.datasetId } });
      }
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteData(initial!.dataId),
    onSuccess: async () => {
      toast.success("已删除用例");
      await queryClient.invalidateQueries({ queryKey: dataKeys.all });
      void navigate({ to: "/datasets" });
    },
  });
  const errors = fieldErrors(save.error);
  const unconfirmedCreate = !initial && isWriteOutcomeUnknown(save.error);
  return (
    <div className="flex flex-col gap-4">
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
        <Button disabled={typeof input === "string" || unconfirmedCreate} loading={save.isPending} onClick={() => { if (typeof input !== "string") save.mutate(input); }}>{initial ? "保存修改" : "创建用例"}</Button>
      </div>
      <ConfirmDialog open={deleting} onClose={() => setDeleting(false)} onConfirm={() => remove.mutate()} loading={remove.isPending} danger
        title="删除用例" description="需要先从所有测试集移出。已有 Project 不受影响。" confirmLabel="删除" />
    </div>
  );
}

export function NewDataPage({ datasetId }: { datasetId: string }) {
  return <Page>
    <PageHeader title="新建用例" crumbs={[{ label: "数据集", to: "/datasets" }, { label: "数据集详情", to: "/datasets/$datasetId", params: { datasetId } }]} />
    <DataForm key={datasetId} target={{ mode: "create", datasetId }} />
  </Page>;
}

export function DataEditorPage({ dataId }: { dataId: string }) {
  const data = useQuery({ queryKey: dataKeys.detail(dataId), queryFn: ({ signal }) => getData(dataId, signal) });
  return (
    <Page>
      <PageHeader title={data.data ? dataTitle(data.data) : "用例"} crumbs={[{ label: "数据集", to: "/datasets" }]} />
      {data.data ? <>
        {data.error && <ErrorBlock error={data.error} onRetry={() => void data.refetch()} />}
        <DataForm key={dataId} target={{ mode: "edit", data: data.data }} />
      </> : data.isPending ? <LoadingBlock /> : <ErrorBlock error={data.error} />}
    </Page>
  );
}
