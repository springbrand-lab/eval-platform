import type { Dispatch, SetStateAction } from "react";
import { dataInputSchema, parseStrictJson } from "@eval-platform/eval-dataset";
import type { DataInput } from "@/api-sdk/data-api";
import type { Data } from "@/api-sdk/types";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/form";
import { MaterialPickerList, ResourcePicker, type PickedResource } from "@/features/resources/resource-picker";

const KNOWN = new Set(["dataId", "name", "description", "userPrompt", "evalPrompt", "initialMaterials", "evalInitialMaterials", "initialSession"]);

export interface DataDraft {
  name: string;
  description: string;
  userPrompt: string;
  evalPrompt: string;
  extra: string;
  initialMaterials: PickedResource[];
  evalInitialMaterials: PickedResource[];
  initialSession: PickedResource | null;
}

export function createDataDraft(data?: Data): DataDraft {
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
export function buildDataInput(draft: DataDraft): DataInput | string {
  if (!draft.name.trim()) return "名称不能为空";
  if (!draft.description.trim()) return "说明不能为空";
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
  for (const [label, picked] of [...draft.initialMaterials.map((item) => ["素材", item] as const), ...draft.evalInitialMaterials.map((item) => ["评估 Agent 素材", item] as const), ["初始上下文", draft.initialSession] as const]) {
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

export function DataDraftFields({ draft, onChange, errors = {} }: {
  draft: DataDraft; onChange: Dispatch<SetStateAction<DataDraft>>; errors?: Record<string, string>;
}) {
  const set = <K extends keyof DataDraft>(key: K, value: DataDraft[K]) => onChange((current) => ({ ...current, [key]: value }));
  return <>
    <Card>
      <CardHeader title="样本" />
      <CardBody className="flex flex-col gap-4">
        <Field label="名称" required error={errors.name}>
          {(id) => <Input id={id} required value={draft.name} onChange={(event) => set("name", event.target.value)} />}
        </Field>
        <Field label="说明" required error={errors.description}>
          {(id) => <Textarea id={id} required rows={3} value={draft.description} onChange={(event) => set("description", event.target.value)} />}
        </Field>
        <Field label="执行 Prompt" required error={errors.userPrompt}>
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
        <Field label="执行 Agent 的素材">{() => <MaterialPickerList label="执行素材" value={draft.initialMaterials} onChange={(value) => set("initialMaterials", value)} />}</Field>
        <Field label="评估 Agent 的素材">{() => <MaterialPickerList label="评估素材" value={draft.evalInitialMaterials} onChange={(value) => set("evalInitialMaterials", value)} />}</Field>
        <Field label="执行 Agent 的初始会话">{() => <ResourcePicker kind="session" label="执行上下文" value={draft.initialSession} onChange={(value) => set("initialSession", value)} />}</Field>
      </CardBody>
    </Card>
    <Card>
      <CardHeader title="其他字段" actions={<span className="text-xs text-text-muted">JSON，原样保存</span>} />
      <CardBody>
        <Field label="JSON">{(id) => <Textarea id={id} mono rows={8} value={draft.extra} onChange={(event) => set("extra", event.target.value)} />}</Field>
      </CardBody>
    </Card>
  </>;
}
