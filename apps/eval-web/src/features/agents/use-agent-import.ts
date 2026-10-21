import { skillQueryKeys, userReferenceQueryKeys } from "@springbrand/agent-config-editor/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type {
  AgentImportCandidate, AgentImportPreview, AgentImportSourceUser, AgentPurpose,
} from "@eval-platform/eval-contracts";
import { agentKeys } from "@/api-sdk/agent-configs-api";
import { applyAgentImport, getAgentImportConfig, getAgentImportTask, previewAgentImport } from "@/api-sdk/agent-imports-api";
import { ApiError } from "@/api-sdk/client";
import { getMe, meKey } from "@/api-sdk/session-api";
import { isWriteOutcomeUnknown } from "@/lib/errors";
import { clearAgentImportPointer, readAgentImportPointer, saveAgentImportPointer } from "./agent-import-pointer";
import {
  AGENT_IMPORT_POLL_MS, agentImportKeys, InvalidAgentImportTaskError, isAgentImportTerminal,
  matchesAgentImportTask, parseAgentImportTask, type AgentImportSession,
} from "./agent-import-state";

const STORAGE_NOTICE = "浏览器无法保存或清理任务定位信息，当前页仍可继续；刷新后可能无法恢复，请保留任务 ID。";

export function useAgentImport(open: boolean) {
  const client = useQueryClient();
  const config = useQuery({
    queryKey: agentImportKeys.config, queryFn: ({ signal }) => getAgentImportConfig(signal), enabled: open, retry: false,
  });
  const [sourceUser, setSourceUser] = useState<AgentImportSourceUser | null>(null);
  const [purpose, setPurpose] = useState<AgentPurpose>("execution");
  const [selected, setSelected] = useState<ReadonlyMap<string, AgentImportCandidate>>(new Map());
  const [session, setSession] = useState<AgentImportSession | null>(null);
  const [recovery, setRecovery] = useState<{ id: string; targetUserId: string } | null>(null);
  const [pointerUser, setPointerUser] = useState<string | null>(null);
  const [pointerNotice, setPointerNotice] = useState<string | null>(null);
  const [posting, setPosting] = useState<"preview" | "apply" | null>(null);
  const [writeError, setWriteError] = useState<{ phase: "preview" | "apply"; error: unknown; unknown: boolean } | null>(null);
  const sending = useRef(false);
  const version = useRef(0);
  const previewIntent = useRef<AgentImportPreview | null>(null);
  const invalidated = useRef(new Set<string>());
  const me = useQuery({
    queryKey: meKey, queryFn: ({ signal }) => getMe(signal), enabled: open || !!session || !!recovery, retry: false,
  });
  // Never look up a pointer using a previous mount's cached identity.
  const targetUserId = me.isFetchedAfterMount && !me.isFetching && !me.error ? me.data?.id : undefined;
  const identityReady = !!targetUserId && pointerUser === targetUserId;
  const activeSession = identityReady && session?.targetUserId === targetUserId ? session : null;
  const locator = activeSession ?? (identityReady && recovery?.targetUserId === targetUserId ? recovery : null);
  const task = useQuery({
    queryKey: agentImportKeys.task(locator?.targetUserId ?? targetUserId ?? "", locator?.id ?? ""),
    queryFn: async ({ signal }) => parseAgentImportTask(await getAgentImportTask(locator!.id, signal), locator!.id),
    enabled: !!locator,
    retry: false,
    // Keep reading after close; the server owns execution and no effect replays a POST.
    refetchInterval: (query) => query.state.data && isAgentImportTerminal(query.state.data.status) ? false : AGENT_IMPORT_POLL_MS,
  });
  const restoring = open && (!identityReady || !!recovery);
  const matches = !!activeSession && !!task.data && matchesAgentImportTask(activeSession, task.data)
    && (activeSession.restored || sourceUser?.id === activeSession.request.sourceUserId && purpose === activeSession.request.purpose);
  const readOnly = !!recovery || !!activeSession?.restored || !!activeSession?.started
    || !!task.data && !["checking", "ready", "failed"].includes(task.data.status);
  const expired = !!task.data?.expiresAt && !(Date.parse(task.data.expiresAt) > Date.now());
  const readyCount = task.data?.agents.filter((agent) => agent.status === "ready").length ?? 0;
  const canApply = matches && !!activeSession?.apply && !activeSession.restored && task.data?.status === "ready" && readyCount > 0 && !expired
    && !posting && !task.error && !me.error && !config.error && !!config.data?.enabled;
  const restoredPreview = !!activeSession?.restored && !!task.data && ["checking", "ready"].includes(task.data.status);
  const canReset = identityReady && !posting && (!readOnly || restoredPreview || !!task.data && isAgentImportTerminal(task.data.status))
    && task.data?.status !== "outcome_unknown" && !task.data?.agents.some((agent) => agent.status === "outcome_unknown")
    && !(writeError?.phase === "apply" && writeError.unknown && task.data?.status === "ready");

  useEffect(() => {
    if (!open || !targetUserId || pointerUser === targetUserId) return;
    version.current += 1;
    previewIntent.current = null;
    setSession(null);
    setSourceUser(null);
    setSelected(new Map());
    setPurpose("execution");
    setWriteError(null);
    const pointer = readAgentImportPointer(targetUserId);
    setPointerUser(targetUserId);
    setRecovery(pointer.taskId ? { id: pointer.taskId, targetUserId } : null);
    setPointerNotice(pointer.issue === "invalid" ? "上次导入的任务定位信息已损坏，已清理；可以重新选择并检查。"
      : pointer.issue === "unavailable" ? STORAGE_NOTICE : null);
  }, [open, pointerUser, targetUserId]);

  useEffect(() => {
    if (!locator || !identityReady || locator.targetUserId !== targetUserId
      || task.isFetching || !task.isFetchedAfterMount) return;
    if (task.error) {
      if (task.error instanceof InvalidAgentImportTaskError
        || task.error instanceof ApiError && [403, 404].includes(task.error.status)) {
        const cleared = clearAgentImportPointer(locator.targetUserId, locator.id);
        version.current += 1;
        previewIntent.current = null;
        setSession(null);
        setRecovery(null);
        setSourceUser(null);
        setSelected(new Map());
        setWriteError(null);
        setPointerNotice(cleared
          ? "上次任务不存在、无权访问或响应无效，已清理定位指针。本次状态读取未触发任何新导入；原任务结果请联系管理员核验。"
          : STORAGE_NOTICE);
      }
      return;
    }
    if (!recovery || !task.data) return;
    const view = task.data;
    setSession({
      id: view.id, targetUserId: recovery.targetUserId, restored: true, started: false,
      request: { sourceUserId: view.sourceUserId, purpose: view.purpose, agentIds: view.agents.map((agent) => agent.id) },
    });
    setPurpose(view.purpose);
    setRecovery(null);
  }, [identityReady, locator, recovery, targetUserId, task.data, task.error, task.isFetchedAfterMount, task.isFetching]);

  useEffect(() => {
    if (!activeSession || !matches || !task.data || !isAgentImportTerminal(task.data.status)) return;
    const key = `${activeSession.targetUserId}:${activeSession.id}:${task.data.status}`;
    if (invalidated.current.has(key)) return;
    invalidated.current.add(key);
    // Resources may have been created even when a root failed or its outcome is unknown.
    void Promise.all([
      client.invalidateQueries({ queryKey: agentKeys.all }),
      client.invalidateQueries({ queryKey: skillQueryKeys.all(activeSession.targetUserId) }),
      client.invalidateQueries({ queryKey: userReferenceQueryKeys.collections(activeSession.targetUserId) }),
      client.invalidateQueries({ queryKey: agentImportKeys.candidatesAll }),
    ]);
  }, [activeSession, client, matches, task.data]);

  function clearPlan() {
    if (locator && !clearAgentImportPointer(locator.targetUserId, locator.id)) setPointerNotice(STORAGE_NOTICE);
    version.current += 1;
    previewIntent.current = null;
    setSession(null);
    setRecovery(null);
    setWriteError(null);
  }
  function chooseUser(user: AgentImportSourceUser) {
    if (!identityReady || sending.current || readOnly || user.id === sourceUser?.id) return;
    clearPlan();
    setSourceUser(user);
    setSelected(new Map());
  }
  function choosePurpose(next: AgentPurpose) {
    if (!identityReady || sending.current || readOnly || next === purpose) return;
    clearPlan();
    setPurpose(next);
  }
  function chooseAgents(next: ReadonlyMap<string, AgentImportCandidate>) {
    if (!identityReady || sending.current || readOnly) return;
    clearPlan();
    setSelected(next);
  }
  function restart() {
    if (sending.current || !canReset) return;
    clearPlan();
    setSelected(new Map());
  }
  async function check() {
    if (!identityReady || recovery || sending.current || session || !sourceUser || !targetUserId || config.error || !config.data?.enabled
      || selected.size === 0 || selected.size > config.data.maxAgents) return;
    const request = previewIntent.current ?? {
      sourceUserId: sourceUser.id, purpose, agentIds: [...selected.keys()].sort(), idempotencyKey: crypto.randomUUID(),
    };
    previewIntent.current = request;
    const current = version.current;
    sending.current = true;
    setPosting("preview");
    setWriteError(null);
    try {
      const result = await previewAgentImport(request);
      if (current === version.current) {
        setSession({
          id: result.taskId, targetUserId, request, apply: { idempotencyKey: crypto.randomUUID() }, started: false, restored: false,
        });
        setPointerNotice(saveAgentImportPointer(targetUserId, result.taskId) ? null : STORAGE_NOTICE);
      }
    } catch (error) {
      if (current === version.current) setWriteError({ phase: "preview", error, unknown: isWriteOutcomeUnknown(error) });
    } finally {
      sending.current = false;
      setPosting(null);
    }
  }
  async function apply() {
    if (sending.current || !activeSession?.apply || activeSession.restored || !canApply) return;
    // Includes retries: the original task, scope and key never follow an edited draft.
    const intent = activeSession;
    const applyRequest = activeSession.apply;
    const current = version.current;
    sending.current = true;
    setPosting("apply");
    setWriteError(null);
    setSession({ ...intent, started: true });
    try {
      const result = await applyAgentImport(intent.id, applyRequest);
      if (current === version.current && result.taskId !== intent.id) setWriteError({
        phase: "apply", unknown: true, error: new Error("返回的任务 ID 与当前检查不一致，请核验原任务，不能继续提交。"),
      });
    } catch (error) {
      const unknown = isWriteOutcomeUnknown(error);
      if (current === version.current) {
        setWriteError({ phase: "apply", error, unknown });
        if (!unknown) setSession((value) => value?.id === intent.id && value.targetUserId === intent.targetUserId ? { ...value, started: false } : value);
      }
    } finally {
      sending.current = false;
      setPosting(null);
      void client.invalidateQueries({ queryKey: agentImportKeys.task(intent.targetUserId, intent.id) });
    }
  }

  return {
    config, me, sourceUser, purpose, selected, session: activeSession, posting, writeError, task, matches, readOnly,
    restoring, pointerNotice, taskId: locator?.id,
    expired, readyCount, canApply, canReset, chooseUser, choosePurpose, chooseAgents, restart, check, apply,
  };
}
