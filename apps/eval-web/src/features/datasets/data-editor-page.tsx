import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Button, FieldSet } from "@springbrand/site-block";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { dataInputSchema, parseStrictJson } from "@eval-platform/eval-dataset";
import { createData, dataKeys, deleteData, getData, updateData, type DataInput } from "@/api-sdk/data-api";
import { datasetKeys } from "@/api-sdk/datasets-api";
import type { Data } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
import { Field, Input, Textarea } from "@/components/ui/form";
import { fieldErrors, isWriteOutcomeUnknown } from "@/lib/errors";
import { CatalogWriteFeedback } from "@/features/catalog-write-feedback";
import { MaterialPickerList, ResourcePicker, type PickedResource } from "@/features/resources/resource-picker";
import { dataTitle } from "./dataset-detail-page";

const KNOWN = new Set(["dataId", "name", "description", "userPrompt", "evalPrompt", "initialMaterials", "evalInitialMaterials", "initialSession"]);

interface DraftState {
  name: string;
  description: string;
  userPrompt: string;
  evalPrompt: string;
  extra: string;
  initialMaterials: PickedResource[];
  evalInitialMaterials: PickedResource[];
  initialSession: PickedResource | null;
}

function toDraft(data?: Data): DraftState {
  const extra = Object.fromEntries(Object.entries(data ?? {}).filter(([key]) => !KNOWN.has(key)));
  return {
    name: typeof data?.name === "string" ? data.name : "",
    description: typeof data?.description === "string" ? data.description : "",
    userPrompt: data?.userPrompt ?? "",
    evalPrompt: data?.evalPrompt ?? "",
    extra: JSON.stringify(extra, null, 2),
    initialMaterials: (data?.initialMaterials ?? []).map((ref) => ({ bundleId: ref.bundleId, id: ref.materialId })),
    evalInitialMaterials: (data?.evalInitialMaterials ?? []).map((ref) => ({ bundleId: ref.bundleId, id: ref.materialId })),
    initialSession: data?.initialSession ? { bundleId: data.initialSession.bundleId, id: data.initialSession.sessionId } : null,
  };
}

/** The Data input, or a message saying what to fix. */
export function buildDataInput(draft: DraftState): DataInput | string {
  if (!draft.name.trim()) return "名称不能为空";
  if (!draft.description.trim()) return "描述不能为空";
  if (!draft.userPrompt.trim()) return "userPrompt 不能为空";
  if (!draft.evalPrompt.trim()) return "evalPrompt 不能为空";
  let extra: unknown;
  try {
    extra = parseStrictJson(draft.extra || "{}");
  } catch (error) {
    return `业务字段 JSON 格式错误：${(error as Error).message}`;
  }
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return "业务字段需要是一个 JSON 对象";
  const reserved = Object.keys(extra).find((key) => KNOWN.has(key));
  if (reserved) return `业务字段不能包含 ${reserved}`;
  for (const [label, picked] of [...draft.initialMaterials.map((item) => ["素材", item] as const), ...draft.evalInitialMaterials.map((item) => ["评委素材", item] as const), ["初始上下文", draft.initialSession] as const]) {
    if (picked && !picked.id) return `请选择${label}，或取消绑定`;
  }
  const parsed = dataInputSchema.safeParse({
    ...(extra as Record<string, unknown>),
    name: draft.name,
    description: draft.description,
    userPrompt: draft.userPrompt,
    evalPrompt: draft.evalPrompt,
    ...(draft.initialMaterials.length ? { initialMaterials: draft.initialMaterials.map((ref) => ({ bundleId: ref.bundleId, materialId: ref.id })) } : {}),
    ...(draft.evalInitialMaterials.length ? { evalInitialMaterials: draft.evalInitialMaterials.map((ref) => ({ bundleId: ref.bundleId, materialId: ref.id })) } : {}),
    ...(draft.initialSession ? { initialSession: { bundleId: draft.initialSession.bundleId, sessionId: draft.initialSession.id } } : {}),
  });
  return parsed.success ? parsed.data : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("；");
}

type DataFormTarget = { mode: "create"; datasetId: string } | { mode: "edit"; data: Data };

function DataForm({ target }: { target: DataFormTarget }) {
  const initial = target.mode === "edit" ? target.data : undefined;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<DraftState>(() => toDraft(initial));
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
  const set = <K extends keyof DraftState>(key: K, value: DraftState[K]) => setDraft((current) => ({ ...current, [key]: value }));
  return (
    <div className="flex flex-col gap-4">
      <FieldSet disabled={save.isPending || unconfirmedCreate} className="min-w-0 gap-4">
      <Card>
        <CardHeader title="样本" />
        <CardBody className="flex flex-col gap-4">
          <Field label="名称" required error={errors.name}>
            {(id) => <Input id={id} required value={draft.name} onChange={(event) => set("name", event.target.value)} />}
          </Field>
          <Field label="描述" required error={errors.description}>
            {(id) => <Textarea id={id} required rows={3} value={draft.description} onChange={(event) => set("description", event.target.value)} />}
          </Field>
          <Field label="启动 Prompt" required error={errors.userPrompt}>
            {(id) => <Textarea id={id} required rows={6} value={draft.userPrompt} onChange={(event) => set("userPrompt", event.target.value)} />}
          </Field>
          <Field label="评估 Prompt" required error={errors.evalPrompt}>
            {(id) => <Textarea id={id} required rows={6} value={draft.evalPrompt} onChange={(event) => set("evalPrompt", event.target.value)} />}
          </Field>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="初始资源" />
        <CardBody className="flex flex-col gap-4">
          <Field label="被测 Agent 的素材">{() => <MaterialPickerList label="执行素材" value={draft.initialMaterials} onChange={(value) => set("initialMaterials", value)} />}</Field>
          <Field label="评委的素材">{() => <MaterialPickerList label="评估素材" value={draft.evalInitialMaterials} onChange={(value) => set("evalInitialMaterials", value)} />}</Field>
          <Field label="被测 Agent 的初始会话">{() => <ResourcePicker kind="session" label="执行上下文" value={draft.initialSession} onChange={(value) => set("initialSession", value)} />}</Field>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="其他字段" actions={<span className="text-xs text-text-muted">JSON，原样保存</span>} />
        <CardBody>
          <Field label="JSON">{(id) => <Textarea id={id} mono rows={8} value={draft.extra} onChange={(event) => set("extra", event.target.value)} />}</Field>
        </CardBody>
      </Card>
      </FieldSet>
      {typeof input === "string" && <p className="text-[13px] text-danger">{input}</p>}
      {initial ? save.error && <ErrorBlock error={save.error} /> : <CatalogWriteFeedback error={save.error} />}
      {unconfirmedCreate && target.mode === "create" && <Button asChild variant="outline">
        <Link to="/datasets/$datasetId" params={{ datasetId: target.datasetId }}>返回数据集核对用例</Link>
      </Button>}
      <div className="sticky bottom-0 -mx-6 flex items-center justify-between gap-3 border-t border-border bg-bg/90 px-6 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
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
