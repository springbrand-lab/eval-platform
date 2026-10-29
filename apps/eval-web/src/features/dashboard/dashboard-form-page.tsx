import { dashboardCreateSchema, dashboardUpdateSchema } from "@eval-platform/eval-contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Save } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiError } from "@/api-sdk/client";
import { createDashboard, dashboardKeys, getDashboard, updateDashboard } from "@/api-sdk/dashboards-api";
import type { Dashboard, DashboardCreateInput, DashboardUpdateInput } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ErrorBlock, LoadingBlock, Notice } from "@/components/ui/feedback";
import { Field, Input, Textarea } from "@/components/ui/form";
import { useInputLimits } from "@/features/input-limits";
import { isWriteOutcomeUnknown } from "@/lib/errors";
import { newIdempotencyKey } from "@/lib/files";
import { DashboardUnavailable } from "./dashboard-page";
import { ProjectPicker } from "./project-picker";
import { validateDashboardReadSearch, type DashboardEditSearch, type DashboardReadSearch, type DashboardSearch } from "./dashboard-search";

type DashboardWrite = { kind: "create"; input: DashboardCreateInput } | { kind: "update"; dashboardId: string; input: DashboardUpdateInput };

export function NewDashboardPage({ search }: { search: DashboardReadSearch }) {
  const limits = useInputLimits();
  if (!limits.data || limits.error) return <Page><PageHeader title="新建看板" />{limits.error ? <ErrorBlock error={limits.error} onRetry={() => void limits.refetch()} /> : <LoadingBlock />}</Page>;
  return <DashboardForm search={search} limit={limits.data.comparisonProjects} />;
}

export function EditDashboardPage({ search }: { search: DashboardEditSearch }) {
  const id = search.dashboardId ?? "";
  const dashboard = useQuery({ queryKey: dashboardKeys.detail(id), queryFn: ({ signal }) => getDashboard(id, signal), enabled: !!id, staleTime: 0 });
  const limits = useInputLimits();
  if (!id) return <DashboardUnavailable />;
  if (!dashboard.data) return dashboard.error ? <DashboardUnavailable error={dashboard.error} onRetry={() => void dashboard.refetch()} /> : <Page><PageHeader title="编辑看板" /><LoadingBlock /></Page>;
  if (!limits.data || limits.error) return <Page><PageHeader title="编辑看板" />{limits.error ? <ErrorBlock error={limits.error} onRetry={() => void limits.refetch()} /> : <LoadingBlock />}</Page>;
  return <DashboardForm key={id} search={search} dashboard={dashboard.data} removeProjectId={search.removeProjectId} limit={limits.data.comparisonProjects} />;
}

function DashboardForm({ search, dashboard, removeProjectId, limit }: {
  search: DashboardReadSearch; dashboard?: Dashboard; removeProjectId?: string; limit: number;
}) {
  const content = useRef<HTMLDivElement>(null);
  const pending = useRef(false);
  const finished = useRef(false);
  const client = useQueryClient();
  const navigate = useNavigate();
  const [base, setBase] = useState(dashboard);
  const [idempotencyKey] = useState(() => newIdempotencyKey("dashboard"));
  const [draft, setDraft] = useState(() => ({
    name: dashboard?.name ?? "", description: dashboard?.description ?? "",
    projectIds: dashboard?.projectIds.filter((id) => id !== removeProjectId) ?? [],
  }));
  const [validationError, setValidationError] = useState("");
  useLayoutEffect(() => {
    const main = content.current?.closest("main");
    if (main) main.scrollTop = 0;
  }, []);
  const complete = async (value: Dashboard) => {
    if (finished.current) return;
    finished.current = true;
    client.setQueryData(dashboardKeys.detail(value.dashboardId), value);
    await Promise.all([
      client.invalidateQueries({ queryKey: dashboardKeys.list(), refetchType: "none" }),
      client.invalidateQueries({ queryKey: dashboardKeys.detail(value.dashboardId), refetchType: "none" }),
    ]);
    toast.success(base ? "看板已保存" : "看板已创建");
    void navigate({ to: "/dashboard", search: { ...validateDashboardReadSearch({ ...search }), dashboardId: value.dashboardId } });
  };
  const write = useMutation({
    mutationFn: (request: DashboardWrite) => request.kind === "create" ? createDashboard(request.input) : updateDashboard(request.dashboardId, request.input),
    meta: { silent: true }, onSuccess: complete, onSettled: () => { pending.current = false; },
  });
  const uncertain = write.isError && isWriteOutcomeUnknown(write.error);
  const conflict = write.error instanceof ApiError && write.error.code === "DASHBOARD_REVISION_CONFLICT";
  const request = write.variables;
  const latest = useQuery({
    queryKey: dashboardKeys.detail(base?.dashboardId ?? ""),
    queryFn: ({ signal }) => getDashboard(base?.dashboardId ?? "", signal),
    enabled: !!base && (uncertain || conflict), staleTime: 0,
  });
  const latestReady = latest.isFetchedAfterMount && !latest.isFetching && !latest.error && !!latest.data;
  const confirmed = uncertain && request?.kind === "update" && latestReady && latest.data
    && latest.data.revision > request.input.revision && latest.data.name === request.input.name.trim()
    && latest.data.description === (request.input.description ?? "").trim()
    && latest.data.projectIds.length === request.input.projectIds.length
    && latest.data.projectIds.every((id, index) => id === request.input.projectIds[index]);
  const versionChanged = request?.kind === "update" && latestReady && latest.data?.revision !== request.input.revision;
  const blockedByVersion = conflict || (uncertain && versionChanged && !confirmed);
  const frozen = write.isPending || uncertain || conflict || write.isSuccess;
  useEffect(() => { if (confirmed && latest.data) void complete(latest.data); }, [confirmed, latest.data]);
  const updateDraft = (patch: Partial<typeof draft>) => {
    if (frozen) return;
    if (write.isError) write.reset();
    setValidationError("");
    setDraft((previous) => ({ ...previous, ...patch }));
  };
  const pickerSearch: DashboardSearch = { ...search, projectId: draft.projectIds };
  const updatePicker = (patch: Partial<DashboardSearch>, replace = false) => {
    if (frozen) return;
    if (patch.projectId) updateDraft({ projectIds: patch.projectId });
    if ("projectSearch" in patch || "projectPage" in patch) {
      const reading = { ...search, projectSearch: patch.projectSearch ?? search.projectSearch, projectPage: "projectPage" in patch ? patch.projectPage : search.projectPage };
      if ("projectSearch" in patch) reading.projectSearch = patch.projectSearch;
      void navigate({ to: base ? "/dashboard/edit" : "/dashboard/new", replace, search: validateDashboardReadSearch({ ...reading }) });
    }
  };
  const proposed = base
    ? dashboardUpdateSchema.safeParse({ ...draft, revision: base.revision })
    : dashboardCreateSchema.safeParse({ ...draft, idempotencyKey });
  const valid = proposed.success && draft.projectIds.length <= limit;
  const retryReady = !!request && !blockedByVersion && (!base || !uncertain || latestReady);
  const submit = () => {
    if (pending.current || finished.current || blockedByVersion) return;
    if (write.isError && request) {
      if (!retryReady) return;
      pending.current = true;
      write.mutate(request);
      return;
    }
    if (!valid || !proposed.success) {
      setValidationError(!draft.name.trim() ? "请填写看板名称" : draft.projectIds.length < 2 ? "请至少选择 2 个项目" : `请检查名称、说明与项目选择，最多选择 ${limit} 个项目。`);
      return;
    }
    pending.current = true;
    if (base) {
      const input = dashboardUpdateSchema.parse({ ...draft, revision: base.revision });
      write.mutate({ kind: "update", dashboardId: base.dashboardId, input });
    } else {
      const input = dashboardCreateSchema.parse({ ...draft, idempotencyKey });
      write.mutate({ kind: "create", input });
    }
  };
  const reload = () => {
    if (!latestReady || !latest.data) return;
    setBase(latest.data);
    setDraft({ name: latest.data.name, description: latest.data.description, projectIds: [...latest.data.projectIds] });
    pending.current = false;
    write.reset();
  };
  const cancel = () => void navigate({ to: "/dashboard", search: base ? { ...validateDashboardReadSearch({ ...search }), dashboardId: base.dashboardId } : {} });
  return <div ref={content}><Page>
    <PageHeader title={base ? "编辑看板" : "新建看板"} description="填写名称，选择要共同观察的项目。只有点击底部保存后，配置才会写入看板；不会执行 Agent。"
      actions={<Button icon={<ArrowLeft />} disabled={write.isPending || uncertain} onClick={cancel}>{base ? "取消编辑" : "返回看板列表"}</Button>} />
    <form className="min-w-0 space-y-4" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <Card><CardHeader title="看板信息" /><CardBody><fieldset disabled={frozen} className="grid min-w-0 gap-4 border-0 p-0 md:grid-cols-2">
        <Field label="看板名称" required>{(id) => <Input id={id} aria-label="看板名称" value={draft.name} onChange={(event) => updateDraft({ name: event.target.value })} placeholder="例如：发布质量观察" />}</Field>
        <Field label="说明（可选）">{(id) => <Textarea id={id} aria-label="看板说明" value={draft.description} onChange={(event) => updateDraft({ description: event.target.value })} className="min-h-20" placeholder="这个看板希望持续观察什么？" />}</Field>
      </fieldset></CardBody></Card>
      {validationError && <p role="alert" className="text-sm text-danger">{validationError}</p>}
      {write.error && <ErrorBlock error={write.error} />}
      {uncertain && <Notice tone="warning">{base ? "保存结果尚未确认，正在读取当前配置核对。未确认前草稿已锁定，重试仍使用原请求。" : "创建结果尚未确认。请使用原请求重试；草稿已锁定，避免重复创建。"}</Notice>}
      {blockedByVersion && <Notice tone="warning">看板已在别处更新，当前草稿尚未覆盖服务器配置。请核对最新版本后显式重载，再决定是否编辑保存。</Notice>}
      {(conflict || (base && uncertain)) && <Card><CardHeader title="当前服务器配置" /><CardBody className="space-y-3">
        {latest.error ? <ErrorBlock error={latest.error} onRetry={() => void latest.refetch()} /> : !latestReady ? <LoadingBlock rows={2} /> : latest.data && <>
          <p className="text-sm font-semibold text-text-strong">{latest.data.name}</p><p className="text-xs text-text-muted">版本 {latest.data.revision} · {latest.data.projectIds.length} 个项目</p>
          <p className="break-words text-xs text-text-secondary">{latest.data.projectIds.join(" · ")}</p>
          {blockedByVersion && <Button onClick={reload}>重新载入最新配置</Button>}
        </>}
      </CardBody></Card>}
      <ProjectPicker search={pickerSearch} onChange={updatePicker} limit={limit} disabled={frozen}
        action={(ready) => <Button type="submit" variant="primary" icon={<Save />} loading={write.isPending}
          disabled={write.isSuccess || blockedByVersion || (write.isError ? !retryReady : !ready || !valid)}>
          {write.isError ? base ? "重试保存" : "重试创建" : base ? "保存看板" : "创建看板"}
        </Button>} />
    </form>
  </Page></div>;
}
