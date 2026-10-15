import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { createData, dataKeys, deleteData, getData, updateData, type DataInput } from "@/api-sdk/data-api";
import { attachData, datasetKeys } from "@/api-sdk/datasets-api";
import type { Data } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
import { Field, Textarea } from "@/components/ui/form";
import { fieldErrors } from "@/lib/errors";
import { ResourcePicker, type PickedResource } from "@/features/resources/resource-picker";
import { dataTitle } from "./dataset-detail-page";

const KNOWN = new Set(["dataId", "userPrompt", "evalPrompt", "initialMaterials", "evalInitialMaterials", "initialSession"]);

interface DraftState {
  userPrompt: string;
  evalPrompt: string;
  extra: string;
  initialMaterials: PickedResource | null;
  evalInitialMaterials: PickedResource | null;
  initialSession: PickedResource | null;
}

function toDraft(data?: Data): DraftState {
  const extra = Object.fromEntries(Object.entries(data ?? {}).filter(([key]) => !KNOWN.has(key)));
  return {
    userPrompt: data?.userPrompt ?? "",
    evalPrompt: data?.evalPrompt ?? "",
    extra: JSON.stringify(extra, null, 2),
    initialMaterials: data?.initialMaterials ? { bundleId: data.initialMaterials.bundleId, id: data.initialMaterials.materialId } : null,
    evalInitialMaterials: data?.evalInitialMaterials ? { bundleId: data.evalInitialMaterials.bundleId, id: data.evalInitialMaterials.materialId } : null,
    initialSession: data?.initialSession ? { bundleId: data.initialSession.bundleId, id: data.initialSession.sessionId } : null,
  };
}

/** The Data input, or a message saying what to fix. */
export function buildDataInput(draft: DraftState): DataInput | string {
  if (!draft.userPrompt.trim()) return "userPrompt 不能为空";
  let extra: unknown;
  try {
    extra = JSON.parse(draft.extra || "{}");
  } catch (error) {
    return `业务字段 JSON 格式错误：${(error as Error).message}`;
  }
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return "业务字段需要是一个 JSON 对象";
  const reserved = Object.keys(extra).find((key) => KNOWN.has(key));
  if (reserved) return `业务字段不能包含 ${reserved}`;
  for (const [label, picked] of [["素材", draft.initialMaterials], ["评委素材", draft.evalInitialMaterials], ["初始会话", draft.initialSession]] as const) {
    if (picked && !picked.id) return `请选择${label}，或取消绑定`;
  }
  return {
    ...(extra as Record<string, unknown>),
    userPrompt: draft.userPrompt,
    ...(draft.evalPrompt.trim() ? { evalPrompt: draft.evalPrompt } : {}),
    ...(draft.initialMaterials ? { initialMaterials: { bundleId: draft.initialMaterials.bundleId, materialId: draft.initialMaterials.id } } : {}),
    ...(draft.evalInitialMaterials ? { evalInitialMaterials: { bundleId: draft.evalInitialMaterials.bundleId, materialId: draft.evalInitialMaterials.id } } : {}),
    ...(draft.initialSession ? { initialSession: { bundleId: draft.initialSession.bundleId, sessionId: draft.initialSession.id } } : {}),
  } as DataInput;
}

function DataForm({ initial, datasetId }: { initial?: Data; datasetId?: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<DraftState>(() => toDraft(initial));
  const [deleting, setDeleting] = useState(false);
  const input = buildDataInput(draft);
  const save = useMutation({
    mutationFn: async () => {
      if (typeof input === "string") throw new Error(input);
      if (initial) return updateData(initial.dataId, input);
      const created = await createData(input);
      if (datasetId) await attachData(datasetId, [created.dataId]);
      return created;
    },
    onSuccess: async (data) => {
      toast.success(initial ? "已保存" : "已创建用例");
      await queryClient.invalidateQueries({ queryKey: dataKeys.all });
      await queryClient.invalidateQueries({ queryKey: datasetKeys.all });
      if (!initial) {
        void navigate(datasetId ? { to: "/datasets/$datasetId", params: { datasetId } } : { to: "/data/$dataId", params: { dataId: data.dataId } });
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
  const set = <K extends keyof DraftState>(key: K, value: DraftState[K]) => setDraft((current) => ({ ...current, [key]: value }));
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="提示词" />
        <CardBody className="flex flex-col gap-4">
          <Field label="userPrompt（给被测 Agent 的任务）" required error={errors.userPrompt}>
            {(id) => <Textarea id={id} rows={6} value={draft.userPrompt} onChange={(event) => set("userPrompt", event.target.value)} />}
          </Field>
          <Field label="evalPrompt（给评委的评审要求）" hint="只执行不评估的用例可以留空；评估时必须填写" error={errors.evalPrompt}>
            {(id) => <Textarea id={id} rows={6} value={draft.evalPrompt} onChange={(event) => set("evalPrompt", event.target.value)} />}
          </Field>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="初始资源" description="执行前放入工作区的素材，以及预置的对话历史" />
        <CardBody className="flex flex-col gap-4">
          <Field label="被测 Agent 的素材">{() => <ResourcePicker kind="material" value={draft.initialMaterials} onChange={(value) => set("initialMaterials", value)} />}</Field>
          <Field label="评委的素材">{() => <ResourcePicker kind="material" value={draft.evalInitialMaterials} onChange={(value) => set("evalInitialMaterials", value)} />}</Field>
          <Field label="被测 Agent 的初始会话">{() => <ResourcePicker kind="session" value={draft.initialSession} onChange={(value) => set("initialSession", value)} />}</Field>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="业务字段" description="name、description 等其他字段，原样保存；提示词测试集中的用例必须有 name 和 description" />
        <CardBody>
          <Field label="JSON">{(id) => <Textarea id={id} mono rows={8} value={draft.extra} onChange={(event) => set("extra", event.target.value)} />}</Field>
        </CardBody>
      </Card>
      {typeof input === "string" && <p className="text-[13px] text-danger">{input}</p>}
      <div className="sticky bottom-0 -mx-6 flex items-center justify-between gap-3 border-t border-border bg-bg/90 px-6 py-3 backdrop-blur">
        {initial ? <Button variant="outline-danger" icon={<Trash2 />} onClick={() => setDeleting(true)}>删除用例</Button> : <span />}
        <Button variant="primary" disabled={typeof input === "string"} loading={save.isPending} onClick={() => save.mutate()}>{initial ? "保存修改" : "创建用例"}</Button>
      </div>
      <ConfirmDialog open={deleting} onClose={() => setDeleting(false)} onConfirm={() => remove.mutate()} loading={remove.isPending} danger
        title="删除用例" description="仍在某个测试集中的用例不能删除，请先从测试集移出。已有 Project 不受影响。" confirmLabel="删除" />
    </div>
  );
}

export function DataEditorPage({ dataId, datasetId }: { dataId?: string; datasetId?: string }) {
  const data = useQuery({ queryKey: dataKeys.detail(dataId ?? "new"), queryFn: ({ signal }) => getData(dataId!, signal), enabled: !!dataId });
  const crumbs = datasetId ? [{ label: "测试集", to: "/datasets" }, { label: "测试集详情", to: "/datasets/$datasetId", params: { datasetId } }] : [{ label: "测试集", to: "/datasets" }];
  if (!dataId) {
    return <Page><PageHeader title="新建用例" crumbs={crumbs} /><DataForm datasetId={datasetId} /></Page>;
  }
  return (
    <Page>
      <PageHeader title={data.data ? dataTitle(data.data) : "用例"} crumbs={crumbs} />
      {data.isPending ? <LoadingBlock /> : data.error ? <ErrorBlock error={data.error} /> : <DataForm key={data.dataUpdatedAt} initial={data.data} />}
    </Page>
  );
}
