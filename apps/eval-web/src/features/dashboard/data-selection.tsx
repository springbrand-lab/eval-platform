import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { ApiError } from "@/api-sdk/client";
import { comparisonKeys } from "@/api-sdk/comparison-api";
import { dashboardKeys, getDashboard, updateDashboard } from "@/api-sdk/dashboards-api";
import type { Dashboard, DashboardUpdateInput } from "@/api-sdk/types";
import { Button } from "@/components/ui/button";
import { ErrorBlock } from "@/components/ui/feedback";
import { isWriteOutcomeUnknown } from "@/lib/errors";

const sameIds = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((id, index) => id === right[index]);
const sorted = (ids: readonly string[]) => [...ids].sort();

function applied(value: Dashboard, request: DashboardUpdateInput) {
  return value.revision > request.revision && value.name === request.name
    && value.description === request.description && sameIds(value.projectIds, request.projectIds)
    && sameIds(sorted(value.excludedDataIds), sorted(request.excludedDataIds ?? []));
}

export function useDataSelection(dashboard: Dashboard | undefined) {
  const client = useQueryClient();
  const inFlight = useRef(false);
  const key = `${dashboard?.dashboardId ?? ""}:${dashboard?.revision ?? 0}`;
  const [draft, setDraft] = useState({ key, removed: new Set<string>(), restore: false });
  const [checking, setChecking] = useState(false);
  const [versionChanged, setVersionChanged] = useState(false);
  const [readError, setReadError] = useState<unknown>(null);
  const stored = dashboard?.excludedDataIds ?? [];
  const complete = (value: Dashboard) => {
    client.setQueryData(dashboardKeys.detail(value.dashboardId), value);
    void client.invalidateQueries({ queryKey: dashboardKeys.list(), refetchType: "none" });
    void client.invalidateQueries({ queryKey: comparisonKeys.all, refetchType: "none" });
    setDraft({ key: `${value.dashboardId}:${value.revision}`, removed: new Set(), restore: false });
    setVersionChanged(false);
    setReadError(null);
  };
  const write = useMutation({
    mutationFn: async (command: { dashboardId: string; input: DashboardUpdateInput }) => {
      try {
        return await updateDashboard(command.dashboardId, command.input);
      } catch (error) {
        if (isWriteOutcomeUnknown(error)) {
          const latest = await getDashboard(command.dashboardId).catch(() => null);
          if (latest && applied(latest, command.input)) return latest;
          if (latest && latest.revision !== command.input.revision) setVersionChanged(true);
        }
        throw error;
      }
    },
    onSuccess: complete,
    onSettled: () => { inFlight.current = false; },
    meta: { silent: true },
  });
  const uncertain = write.isError && isWriteOutcomeUnknown(write.error);
  const conflict = versionChanged || (write.error instanceof ApiError && write.error.code === "DASHBOARD_REVISION_CONFLICT");
  const busy = checking || write.isPending;
  const frozen = busy || uncertain || conflict;
  const current = draft.key === key || frozen ? draft : { key, removed: new Set<string>(), restore: false };
  const excluded = sorted([...new Set([...(current.restore ? [] : stored), ...current.removed])]);
  const dirty = !sameIds(excluded, sorted(stored));
  const change = (ids: readonly string[], checked: boolean) => {
    if (frozen) return;
    write.reset();
    setReadError(null);
    setDraft((previous) => {
      const base = previous.key === key ? previous : { key, removed: new Set<string>(), restore: false };
      const removed = new Set(base.removed);
      for (const id of ids) { if (checked) removed.delete(id); else removed.add(id); }
      return { ...base, removed };
    });
  };
  const restore = () => {
    if (frozen) return;
    write.reset();
    setReadError(null);
    setDraft({ key, removed: new Set(), restore: true });
  };
  const confirm = () => {
    if (!dashboard || !dirty || frozen || inFlight.current) return;
    inFlight.current = true;
    write.mutate({
      dashboardId: dashboard.dashboardId,
      input: {
        name: dashboard.name, description: dashboard.description, projectIds: [...dashboard.projectIds],
        revision: dashboard.revision, excludedDataIds: excluded,
      },
    });
  };
  const verify = async (reload: boolean) => {
    const command = write.variables;
    if (!command || busy || inFlight.current) return;
    inFlight.current = true;
    setChecking(true);
    setReadError(null);
    let replaying = false;
    try {
      const latest = await getDashboard(command.dashboardId);
      if (reload || applied(latest, command.input)) {
        complete(latest);
        write.reset();
      } else if (latest.revision === command.input.revision) {
        replaying = true;
        write.mutate(command);
      } else {
        setVersionChanged(true);
      }
    } catch (error) {
      setReadError(error);
    } finally {
      setChecking(false);
      if (!replaying) inFlight.current = false;
    }
  };
  return {
    checked: (id: string) => !current.removed.has(id),
    change, restore, confirm, dirty, frozen, busy,
    removedCount: current.removed.size, excludedCount: stored.length, restoring: current.restore,
    error: readError ?? write.error, uncertain, conflict,
    retry: () => { void verify(false); },
    reload: () => { void verify(true); },
  };
}

export type DataSelection = ReturnType<typeof useDataSelection>;

export function DataSelectionActions({ selection }: { selection: DataSelection }) {
  return <section aria-label="共同数据展示选择" className="min-w-0 space-y-2">
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-text-muted">
      <p aria-live="polite">{selection.restoring ? "待恢复全部，点击确定生效" : selection.removedCount
        ? `已取消 ${selection.removedCount} 条，点击确定后更新整个看板` : "勾选保留的数据，点击确定后更新整个看板"}
        {selection.excludedCount > 0 && <span className="ml-2">看板已排除 {selection.excludedCount} 条</span>}</p>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={selection.restore} disabled={selection.frozen || (!selection.excludedCount && !selection.removedCount)}>恢复全部</Button>
        <Button size="sm" variant="primary" onClick={selection.confirm} disabled={!selection.dirty || selection.frozen} loading={selection.busy}>确定</Button>
      </div>
    </div>
    {!!selection.error && <ErrorBlock error={selection.error} />}
    {selection.conflict ? <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
      <span>看板已被其他窗口修改，未覆盖新配置。重新加载后再勾选。</span>
      <Button size="sm" onClick={selection.reload} loading={selection.busy}>重新加载选择</Button>
    </div> : selection.uncertain && <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
      <span>保存结果未确认，已保留原请求。先读取服务器核对，再决定是否重试。</span>
      <Button size="sm" onClick={selection.retry} loading={selection.busy}>核对并重试</Button>
    </div>}
  </section>;
}
