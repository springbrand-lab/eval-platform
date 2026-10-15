import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Lock, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  agentKeys, createAgentConfig, deleteAgentConfig, getAgentConfig, updateAgentConfig,
} from "@/api-sdk/agent-configs-api";
import type { AgentConfig } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { ErrorBlock, LoadingBlock, Notice } from "@/components/ui/feedback";
import { Field, Input, Textarea } from "@/components/ui/form";
import { fieldErrors } from "@/lib/errors";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const FROZEN_PREFIX = "eval-frozen-";

function isFrozen(config: AgentConfig | undefined): boolean {
  return !!config?.slug?.startsWith(FROZEN_PREFIX);
}

function AgentForm({ initial, onSaved }: { initial?: AgentConfig; onSaved: (config: AgentConfig) => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const frozen = isFrozen(initial);
  const [slug, setSlug] = useState(initial?.slug ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [setting, setSetting] = useState(() => JSON.stringify(initial?.setting ?? {}, null, 2));
  const [deleting, setDeleting] = useState(false);

  let parsedSetting: unknown;
  let settingError: string | undefined;
  try {
    parsedSetting = JSON.parse(setting);
    if (!parsedSetting || typeof parsedSetting !== "object" || Array.isArray(parsedSetting)) settingError = "需要是一个 JSON 对象";
  } catch (error) {
    settingError = `JSON 格式错误：${(error as Error).message}`;
  }
  const slugError = slug && (!SLUG.test(slug) || slug.startsWith(FROZEN_PREFIX))
    ? "只能用小写字母、数字和连字符，且不能以 eval-frozen- 开头" : undefined;
  const valid = slug && !slugError && name.trim() && !settingError;

  const save = useMutation({
    mutationFn: () => {
      const body = { slug, name: name.trim(), description: description.trim() || null, setting: parsedSetting };
      return initial ? updateAgentConfig(initial.id, { ...body, revision: initial.revision ?? 1 }) : createAgentConfig(body);
    },
    onSuccess: async (config) => {
      toast.success(initial ? "已保存" : "已创建");
      await queryClient.invalidateQueries({ queryKey: agentKeys.all });
      onSaved(config);
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteAgentConfig(initial!.id),
    onSuccess: async () => {
      toast.success("已删除");
      await queryClient.invalidateQueries({ queryKey: agentKeys.all });
      void navigate({ to: "/agents" });
    },
  });
  const errors = fieldErrors(save.error);

  return (
    <div className="flex flex-col gap-4">
      {frozen && (
        <Notice tone="warning">
          <span className="inline-flex items-center gap-1.5 font-medium"><Lock className="size-4" />这是某个 Project 的冻结副本</span>
          ，只能查看，不能修改或删除。
        </Notice>
      )}
      <Card>
        <CardHeader title="基本信息" />
        <CardBody className="grid gap-4 md:grid-cols-2">
          <Field label="Slug" required error={slugError ?? errors.slug} hint="唯一标识，例如 subject-hello">
            {(id) => <Input id={id} value={slug} disabled={frozen} onChange={(event) => setSlug(event.target.value.trim())} />}
          </Field>
          <Field label="名称" required error={errors.name}>
            {(id) => <Input id={id} value={name} disabled={frozen} maxLength={200} onChange={(event) => setName(event.target.value)} />}
          </Field>
          <Field label="说明" className="md:col-span-2" error={errors.description}>
            {(id) => <Textarea id={id} rows={2} value={description ?? ""} disabled={frozen} maxLength={2000} onChange={(event) => setDescription(event.target.value)} />}
          </Field>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Agent 设置（setting）" description="与 Eval SP user-agent-configs 接口的 setting 字段一致：模型、行为、工具等。" />
        <CardBody>
          <Field label="setting JSON" error={settingError ?? errors.setting}>
            {(id) => <Textarea id={id} mono rows={18} value={setting} disabled={frozen} onChange={(event) => setSetting(event.target.value)} />}
          </Field>
        </CardBody>
      </Card>
      {!frozen && (
        <div className="flex items-center justify-between">
          {initial ? (
            <Button variant="ghost" icon={<Trash2 className="size-4" />} className="text-danger" onClick={() => setDeleting(true)}>删除</Button>
          ) : <span />}
          <Button variant="primary" disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>{initial ? "保存" : "创建"}</Button>
        </div>
      )}
      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        onConfirm={() => remove.mutate()}
        loading={remove.isPending}
        danger
        title="删除 Agent 配置"
        description="删除后不能恢复。已创建的 Project 使用的是冻结副本，不受影响。"
        confirmLabel="删除"
      />
    </div>
  );
}

export function AgentEditorPage({ id }: { id?: string }) {
  const navigate = useNavigate();
  const config = useQuery({
    queryKey: agentKeys.detail(id ?? "new"),
    queryFn: ({ signal }) => getAgentConfig(id!, signal),
    enabled: !!id,
  });
  const [key, setKey] = useState(0);
  useEffect(() => setKey((value) => value + 1), [config.data?.revision]);
  const crumbs = [{ label: "Agent", to: "/agents" }];
  if (!id) {
    return (
      <Page>
        <PageHeader title="新建 Agent" crumbs={crumbs} />
        <AgentForm onSaved={(created) => void navigate({ to: "/agents/$id", params: { id: created.id } })} />
      </Page>
    );
  }
  return (
    <Page>
      <PageHeader title={config.data?.name ?? "Agent"} crumbs={crumbs} />
      {config.isPending ? <LoadingBlock /> : config.error ? <ErrorBlock error={config.error} onRetry={() => void config.refetch()} /> : (
        <AgentForm key={key} initial={config.data} onSaved={() => void config.refetch()} />
      )}
    </Page>
  );
}
