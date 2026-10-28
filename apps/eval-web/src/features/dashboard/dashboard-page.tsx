import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { ArrowLeft, Pencil, RefreshCw } from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { comparisonKeys, getProjectComparison } from "@/api-sdk/comparison-api";
import { dashboardKeys, getDashboard } from "@/api-sdk/dashboards-api";
import type { Dashboard } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorBlock, LoadingBlock, Notice } from "@/components/ui/feedback";
import { useInputLimits } from "@/features/input-limits";
import { POLL_MS } from "@/features/runs/use-run-polling";
import { clearedDataScope, validateDashboardReadSearch, type ChangeDashboardSearch, type DashboardReadSearch } from "./dashboard-search";
import { ComparisonWorkbench } from "./comparison-workbench";
import { DashboardsPage } from "./dashboards-page";
import { useDataSelection } from "./data-selection";

const isDashboardPath = (path: string) => path === "/dashboard" || path === "/dashboard/";

export function DashboardUnavailable({ error, onRetry }: { error?: unknown; onRetry?: () => void }) {
  return <Page><PageHeader title="无法打开看板" actions={<Button asChild icon={<ArrowLeft />}><Link to="/dashboard" search={{}}>返回看板列表</Link></Button>} />
    <Card className="space-y-3 p-4"><p className="text-sm text-text-muted">看板可能不存在，或当前账号不可见。可以返回列表选择其他看板。</p>{!!error && <ErrorBlock error={error} onRetry={onRetry} />}</Card>
  </Page>;
}

export function DashboardPage({ search }: { search: DashboardReadSearch }) {
  const router = useRouter();
  const navigate = useNavigate({ from: "/dashboard/" });
  useEffect(() => {
    const query = new URLSearchParams(router.history.location.search);
    const sorting = search.dashboardSort === undefined ? [] : [JSON.stringify(search.dashboardSort)];
    if (isDashboardPath(router.history.location.pathname) && (query.has("projectId") || query.has("view")
      || JSON.stringify(query.getAll("dashboardSort")) !== JSON.stringify(sorting))) {
      void navigate({ to: "/dashboard", replace: true, search: (previous) => validateDashboardReadSearch({ ...previous }) });
    }
  }, [search, router, navigate]);
  return search.dashboardId ? <SavedDashboard key={search.dashboardId} dashboardId={search.dashboardId} search={search} /> : <DashboardsPage search={search} />;
}

function SavedDashboard({ dashboardId, search }: { dashboardId: string; search: DashboardReadSearch }) {
  const content = useRef<HTMLDivElement>(null);
  const client = useQueryClient();
  const router = useRouter();
  const navigate = useNavigate({ from: "/dashboard/" });
  const dashboard = useQuery({ queryKey: dashboardKeys.detail(dashboardId), queryFn: ({ signal }) => getDashboard(dashboardId, signal), staleTime: 0 });
  const selection = useDataSelection(dashboard.data);
  const limits = useInputLimits();
  const limit = limits.data?.comparisonProjects;
  const ids = dashboard.data?.projectIds;
  const comparing = !!ids && limit !== undefined && ids.length >= 2 && ids.length <= limit;
  const readingScope = JSON.stringify([dashboardId, ids, search.jsonPointer, search.datasetId, search.dataId]);
  useLayoutEffect(() => {
    const main = content.current?.closest("main");
    if (main) main.scrollTop = 0;
  }, [readingScope]);
  const onChange: ChangeDashboardSearch = (patch, replace = false) => {
    void navigate({ to: "/dashboard", replace, search: (previous) => validateDashboardReadSearch({ ...previous, ...patch, dashboardId }) });
  };
  const query = {
    projectIds: ids ?? [], datasetId: search.datasetId, jsonPointer: search.jsonPointer,
    ...(dashboard.data?.excludedDataIds?.length ? { excludedDataIds: dashboard.data.excludedDataIds } : {}),
  };
  const comparison = useQuery({
    queryKey: comparisonKeys.view(query), queryFn: ({ signal }) => getProjectComparison(query, signal),
    enabled: comparing && !dashboard.error && !limits.error, staleTime: 0, refetchInterval: POLL_MS, refetchIntervalInBackground: false,
  });
  const defaultPointer = comparison.data?.selectedField?.jsonPointer;
  useEffect(() => {
    if (comparing && ids && search.jsonPointer === undefined && defaultPointer !== undefined && isDashboardPath(router.history.location.pathname)) {
      void navigate({
        to: "/dashboard", replace: true,
        search: (previous) => {
          const current = client.getQueryData<Dashboard>(dashboardKeys.detail(dashboardId));
          const sameProjects = current?.projectIds.length === ids.length && current.projectIds.every((id, index) => id === ids[index]);
          const sameScope = isDashboardPath(router.history.location.pathname) && previous.dashboardId === dashboardId
            && previous.datasetId === search.datasetId && sameProjects;
          return sameScope && previous.jsonPointer === undefined ? { ...previous, jsonPointer: defaultPointer } : previous;
        },
      });
    }
  }, [comparing, ids, dashboardId, search.jsonPointer, search.datasetId, defaultPointer, client, router, navigate]);
  const edit = (removeProjectId?: string) => void navigate({ to: "/dashboard/edit", search: { ...search, dashboardId, removeProjectId } });
  if (dashboard.error) return <DashboardUnavailable error={dashboard.error} onRetry={() => void dashboard.refetch()} />;
  return <div ref={content}><Page>
    <PageHeader title={dashboard.data?.name ?? "打开看板"} description={dashboard.data?.description || "并排看清共同数据的表现，再逐层定位到结果与产物。"}
      actions={<>
        <Button asChild size="sm" icon={<ArrowLeft />}><Link to="/dashboard" search={{}}>看板列表</Link></Button>
        <Button size="sm" icon={<RefreshCw />} loading={dashboard.isFetching || comparison.isFetching} onClick={() => { void dashboard.refetch(); void comparison.refetch(); }}>刷新</Button>
        <Button asChild size="sm" icon={<Pencil />} disabled={!dashboard.data}><Link to="/dashboard/edit" search={{ ...search, dashboardId }}>编辑看板</Link></Button>
      </>} />
    {!dashboard.data || limits.isPending ? <Card><LoadingBlock /></Card>
      : limits.error || limit === undefined ? <Card className="p-4"><p className="mb-3 text-sm text-text-muted">暂时无法读取项目选择上限，请重试后继续。</p><ErrorBlock error={limits.error ?? new Error("项目对比上限不可用")} onRetry={() => void limits.refetch()} /></Card>
        : !comparing ? <Notice tone="warning">当前看板的项目数量不符合上限要求，请编辑看板，选择 2–{limit} 个项目后显式保存。</Notice>
          : comparison.error ? <div className="space-y-3"><ErrorBlock error={comparison.error} onRetry={() => void comparison.refetch()} /><Notice tone="neutral">如果引用的项目已被删除，可编辑看板修复项目选择；修改只有在保存后生效。</Notice>
            {search.datasetId && <Button onClick={() => onChange({ ...clearedDataScope, datasetId: undefined })}>返回全部共同数据</Button>}</div>
            : !comparison.data ? <Card><LoadingBlock /></Card> : <ComparisonWorkbench
              view={comparison.data} search={{ ...search, projectId: [...dashboard.data.projectIds] }} onChange={onChange}
              onRemove={edit} selection={selection} />}
  </Page></div>;
}
