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
import { getEvaluationResultsMcp, mcpServerKeys } from "@/api-sdk/mcp-servers-api";
import { ApiError, api } from "@/api-sdk/client";
import { getMe, meKey } from "@/api-sdk/session-api";
import type { AgentConfig } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
import { AgentPurposeSelector, type AgentPurpose } from "./agent-purpose";
import { AgentMcpServers } from "./agent-mcp-servers";

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
  const [purpose, setPurpose] = useState<AgentPurpose>("execution");
  const [purposeReady, setPurposeReady] = useState(false);
  const [slug] = useState(() => `agent-${crypto.randomUUID()}`);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteBlocker, setDeleteBlocker] = useState<AgentDeletionFeedback | null>(null);
  const submitting = useRef(false);
  const allowNavigation = useRef(false);
  const purposeUserChanged = useRef(false);
  const readOnly = !!base?.slug.startsWith(FROZEN_PREFIX);
  const dirty = !agentDraftEqual(draft, baseline);
  const models = useQuery({ queryKey: agentLibraryKeys.models, queryFn: ({ signal }) => agentEditorClient.models.listModelCatalog(signal) });
  const evaluationMcp = useQuery({
    queryKey: mcpServerKeys.evaluationResults,
    queryFn: ({ signal }) => getEvaluationResultsMcp(signal),
    retry: false,
  });
  const evaluationMcpId = evaluationMcp.data?.kind === "available" ? evaluationMcp.data.server.id : undefined;

  useEffect(() => {
    if (evaluationMcp.isPending || (!initial && !template)) return;
    const source = initial ?? template;
    if (!purposeReady) setPurposeReady(true);
    if (!purposeUserChanged.current && evaluationMcpId) {
      setPurpose(source?.setting.mcpServers.some((selection) => selection.serverId === evaluationMcpId) ? "evaluation" : "execution");
    }
  }, [evaluationMcp.isPending, evaluationMcpId, initial, purposeReady, template]);

  useEffect(() => {
    if (!purposeReady || !evaluationMcpId) return;
    const selected = draft.setting.mcpServers.some((selection) => selection.serverId === evaluationMcpId);
    if ((purpose === "evaluation" && selected) || (purpose === "execution" && (!selected || !purposeUserChanged.current))) return;
    allowNavigation.current = false;
    setError(null);
    setDraft((current) => {
      if (purpose === "evaluation" && !selected) {
        return { ...current, setting: { ...current.setting, mcpServers: [...current.setting.mcpServers, { serverId: evaluationMcpId }] } };
      }
      if (purpose === "execution" && selected) {
        return { ...current, setting: { ...current.setting, mcpServers: current.setting.mcpServers.filter((selection) => selection.serverId !== evaluationMcpId) } };
      }
      return current;
    });
  }, [draft.setting.mcpServers, evaluationMcpId, purpose, purposeReady]);

  function changePurpose(next: AgentPurpose) {
    purposeUserChanged.current = true;
    setPurpose(next);
  }

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
          ? "此 Agent 已在其他位置更新。你的修改仍然保留，请重新加载页面获取最新配置。"
          : failure instanceof Error ? failure.message : "保存失败。你的修改仍然保留，请重试。");
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
    if (purpose === "evaluation") {
      if (!purposeReady || evaluationMcp.isPending) {
        setError("正在读取评估结果 MCP，请稍后再保存。");
        return;
      }
      if (evaluationMcp.error) {
        setError(`无法读取评估结果 MCP：${evaluationMcp.error instanceof Error ? evaluationMcp.error.message : "请求失败"}`);
        return;
      }
      if (evaluationMcp.data?.kind !== "available" || !evaluationMcpId) {
        setError(evaluationMcp.data?.kind === "unavailable" ? evaluationMcp.data.reason : "评估结果 MCP 不可用，请先完成配置。");
        return;
      }
      if (!draft.setting.mcpServers.some((selection) => selection.serverId === evaluationMcpId)) {
        setError("评估结果 MCP 尚未加入配置，请稍后再保存。");
        return;
      }
    }
    let request: SaveRequest;
    try {
      request = base ? { kind: "update", id: base.id, input: updateInputFromDraft(draft, base.revision) }
        : { kind: "create", input: createInputFromDraft(draft, slug) };
    } catch (failure) {
      const issue = failure instanceof ZodError ? failure.issues[0] : undefined;
      setError(issue ? `${issue.path.join(".") || "Agent 配置"}: ${issue.message}` : "请检查配置后再保存。");
      return;
    }
    submitting.current = true;
    setError(null);
    save.mutate(request);
  }
  const common = {
    supplementaryContent: <>
      <AgentPurposeSelector
        purpose={purpose}
        resolution={evaluationMcp.data}
        loading={evaluationMcp.isPending || !purposeReady}
        error={evaluationMcp.error}
        readOnly={readOnly}
        onChange={changePurpose}
      />
      <AgentMcpServers selections={draft.setting.mcpServers} />
    </>,
    userId, draft, models: models.data ?? [], modelsLoading: models.isPending, modelsError: models.isError,
    readOnly, saving: save.isPending, error, onSave: submit,
    onDraftChange: (update: (current: AgentDraft) => AgentDraft) => {
      allowNavigation.current = false;
      setDraft(update);
      setError(null);
    },
    onBack: () => { if (!save.isPending) { allowNavigation.current = true; void navigate({ to: "/agents" }); } },
  };
  return <div className="agent-editor-layout">
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
  </div>;
}

export function AgentEditorPage({ id }: { id?: string }) {
  const navigate = useNavigate();
  const me = useQuery({ queryKey: meKey, queryFn: ({ signal }) => getMe(signal) });
  const config = useQuery({ queryKey: agentKeys.detail(id ?? "new"), queryFn: ({ signal }) => getAgentConfig(id!, signal), enabled: !!id });
  const template = useQuery({ queryKey: agentLibraryKeys.template, queryFn: ({ signal }) => getAgentTemplate(signal), enabled: !id });
  const source = id ? config : template;
  const failed = me.error ? me : source.error ? source : null;
  const ready = !!me.data && (id ? !!config.data : !!template.data);
  return <Page>
    <PageHeader compact title={id ? config.data?.name ?? "Agent" : "新建 Agent"} crumbs={[{ label: "Agent 管理", to: "/agents" }]}
      description="配置行为、模型与可用能力。修改后保存，供项目执行或评估使用。" />
    {failed && <ErrorBlock error={failed.error} onRetry={() => void failed.refetch()} />}
    {ready ? <AgentForm key={id ?? "new"} initial={config.data} template={template.data} userId={me.data!.id}
      onSaved={(saved) => { if (!id) void navigate({ to: "/agents/$id", params: { id: saved.id } }); }} /> : !failed && <LoadingBlock />}
    {!id && !ready && <div><Button onClick={() => void navigate({ to: "/agents" })}>取消</Button></div>}
  </Page>;
}
