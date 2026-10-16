import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ZodError } from "zod";
import {
  AgentCreationError, AgentEditor, AgentEditorProvider, agentDraftEqual, createAgentFromInput,
  createInputFromDraft, deletionBlockerFeedback, deletionErrorFeedback, describeAgentCreationError,
  draftFromAgent, updateInputFromDraft, type AgentDeletionFeedback, type AgentDraft,
} from "@springbrand/agent-config-editor";
import type { AgentConfigDeletionCheck, CreateUserAgentConfigInput, UpdateUserAgentConfigInput, UserAgentConfigTemplate } from "@springbrand/agent-config-editor/client";
import {
  agentKeys, createAgentConfig, deleteAgentConfig, getAgentConfig, updateAgentConfig,
} from "@/api-sdk/agent-configs-api";
import { agentEditorClient, agentLibraryKeys, getAgentTemplate } from "@/api-sdk/agent-editor-api";
import { ApiError, api } from "@/api-sdk/client";
import { getMe, meKey } from "@/api-sdk/session-api";
import type { AgentConfig } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { ErrorBlock, LoadingBlock } from "@/components/ui/feedback";

const FROZEN_PREFIX = "eval-frozen-";
type SaveRequest = { kind: "create"; input: CreateUserAgentConfigInput }
  | { kind: "update"; id: string; input: UpdateUserAgentConfigInput };

function AgentForm({ initial, template, userId, onSaved }: {
  initial?: AgentConfig; template?: UserAgentConfigTemplate; userId: string; onSaved: (config: AgentConfig) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [base, setBase] = useState(initial);
  const [baseline, setBaseline] = useState<AgentDraft>(() => initial ? draftFromAgent(initial)
    : { name: "", description: "", setting: template!.setting });
  const [draft, setDraft] = useState(baseline);
  const [slug] = useState(() => `agent-${crypto.randomUUID()}`);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteBlocker, setDeleteBlocker] = useState<AgentDeletionFeedback | null>(null);
  const submitting = useRef(false);
  const allowNavigation = useRef(false);
  const readOnly = !!base?.slug.startsWith(FROZEN_PREFIX);
  const dirty = !agentDraftEqual(draft, baseline);
  const models = useQuery({ queryKey: agentLibraryKeys.models, queryFn: ({ signal }) => agentEditorClient.models.listModelCatalog(signal) });

  useEffect(() => {
    if (!initial || dirty || base?.revision === initial.revision) return;
    setBase(initial);
    const next = draftFromAgent(initial);
    setBaseline(next);
    setDraft(next);
  }, [initial, dirty, base?.revision]);

  const save = useMutation({
    mutationFn: (request: SaveRequest) => request.kind === "create"
      ? createAgentFromInput({ create: createAgentConfig, update: updateAgentConfig }, request.input)
      : updateAgentConfig(request.id, request.input),
    onSuccess: (config) => {
      setBase(config);
      const next = draftFromAgent(config);
      setBaseline(next);
      setDraft(next);
      setError(null);
      allowNavigation.current = true;
      queryClient.setQueryData(agentKeys.detail(config.id), config);
      toast.success(initial ? "已保存" : "已创建");
      onSaved(config);
    },
    onError: (failure) => {
      setError(failure instanceof AgentCreationError ? describeAgentCreationError(failure)
        : failure instanceof ApiError && failure.status === 409
          ? "This Agent changed elsewhere. Your edits are still here. Reload the page to load its latest settings."
          : failure instanceof Error ? failure.message : "Could not save this Agent. Your edits are still here.");
    },
    onSettled: () => {
      submitting.current = false;
      void queryClient.invalidateQueries({ queryKey: agentKeys.all });
    },
  });
  const blocker = useBlocker({
    shouldBlockFn: () => !allowNavigation.current,
    disabled: !dirty && !save.isPending,
    enableBeforeUnload: dirty || save.isPending,
    withResolver: true,
  });
  const deletionCheck = useMutation({
    mutationFn: () => api.get<AgentConfigDeletionCheck>(`/api/agent-library/user-agent-configs/${encodeURIComponent(base!.id)}/deletion-check`),
    onSuccess: (check) => {
      const feedback = deletionBlockerFeedback(check);
      setDeleteBlocker(feedback);
      if (!feedback) setDeleting(true);
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteAgentConfig(base!.id),
    onSuccess: () => {
      allowNavigation.current = true;
      toast.success("已删除");
      void queryClient.invalidateQueries({ queryKey: agentKeys.all });
      void navigate({ to: "/agents" });
    },
  });
  function submit() {
    if (readOnly || submitting.current) return;
    let request: SaveRequest;
    try {
      request = base ? { kind: "update", id: base.id, input: updateInputFromDraft(draft, base.revision) }
        : { kind: "create", input: createInputFromDraft(draft, slug) };
    } catch (failure) {
      const issue = failure instanceof ZodError ? failure.issues[0] : undefined;
      setError(issue ? `${issue.path.join(".") || "Agent settings"}: ${issue.message}` : "Check the Agent settings before saving.");
      return;
    }
    submitting.current = true;
    setError(null);
    save.mutate(request);
  }
  const common = {
    userId, draft, models: models.data ?? [], modelsLoading: models.isPending, modelsError: models.isError,
    readOnly, saving: save.isPending, error, onSave: submit,
    onDraftChange: (update: (current: AgentDraft) => AgentDraft) => {
      allowNavigation.current = false;
      setDraft(update);
      setError(null);
    },
    onBack: () => { if (!save.isPending) { allowNavigation.current = true; void navigate({ to: "/agents" }); } },
  };
  return <>
    <AgentEditorProvider client={agentEditorClient} connectorReturnTo={base ? `/agents/${encodeURIComponent(base.id)}` : "/agents/new"}>
      {base ? <AgentEditor mode="edit" {...common} agent={base} dirty={dirty}
        checkingDelete={deletionCheck.isPending} deleteBlocker={deleteBlocker}
        deleteCheckError={deletionCheck.error ? deletionErrorFeedback(deletionCheck.error).message : null}
        onDelete={() => { if (!readOnly) deletionCheck.mutate(); }} /> : <AgentEditor mode="create" {...common} />}
    </AgentEditorProvider>
    <ConfirmDialog open={deleting} onClose={() => { if (!remove.isPending) setDeleting(false); }}
      onConfirm={() => remove.mutate()} loading={remove.isPending} danger title="删除 Agent 配置"
      description={<>{remove.error ? <span role="alert">{deletionErrorFeedback(remove.error).message}</span> : "已有项目的执行配置不受影响。"}</>} confirmLabel="删除" />
    <ConfirmDialog open={blocker.status === "blocked"} onClose={() => { if (blocker.status === "blocked") blocker.reset(); }}
      onConfirm={() => { if (!save.isPending && blocker.status === "blocked") { allowNavigation.current = true; blocker.proceed(); } }}
      loading={save.isPending} title={save.isPending ? "正在保存 Agent" : "放弃未保存的修改？"}
      description={save.isPending ? "请等待保存完成。" : "离开后，本次未提交的修改会丢弃。"} confirmLabel="放弃修改" />
  </>;
}

export function AgentEditorPage({ id }: { id?: string }) {
  const navigate = useNavigate();
  const me = useQuery({ queryKey: meKey, queryFn: ({ signal }) => getMe(signal) });
  const config = useQuery({ queryKey: agentKeys.detail(id ?? "new"), queryFn: ({ signal }) => getAgentConfig(id!, signal), enabled: !!id });
  const template = useQuery({ queryKey: agentLibraryKeys.template, queryFn: ({ signal }) => getAgentTemplate(signal), enabled: !id });
  const source = id ? config : template;
  const failed = me.error ? me : source.error ? source : null;
  const ready = !!me.data && (id ? !!config.data : !!template.data);
  return <Page narrow>
    <PageHeader title={id ? config.data?.name ?? "Agent" : "新建 Agent"} crumbs={[{ label: "Agent", to: "/agents" }]}
      description="先定义行为与模型，再按任务选择能力和参考资料。保存后可在项目的执行或评估计划中使用。" />
    {failed && <ErrorBlock error={failed.error} onRetry={() => void failed.refetch()} />}
    {ready ? <AgentForm key={id ?? "new"} initial={config.data} template={template.data} userId={me.data!.id}
      onSaved={(saved) => { if (!id) void navigate({ to: "/agents/$id", params: { id: saved.id } }); }} /> : !failed && <LoadingBlock />}
    {!id && !ready && <div><Button onClick={() => void navigate({ to: "/agents" })}>取消</Button></div>}
  </Page>;
}
