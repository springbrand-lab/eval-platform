import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { LayoutDashboard, Plus } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { dashboardKeys, listDashboards } from "@/api-sdk/dashboards-api";
import type { Dashboard } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState, ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
import { formatDateTime } from "@/lib/format";
import { validateDashboardReadSearch, type DashboardReadSearch } from "./dashboard-search";

export function DashboardsPage({ search }: { search: DashboardReadSearch }) {
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const main = content.current?.closest("main");
    if (main) main.scrollTop = 0;
  }, []);
  const navigate = useNavigate({ from: "/dashboard/" });
  const dashboards = useQuery({ queryKey: dashboardKeys.list(), queryFn: ({ signal }) => listDashboards(signal), staleTime: 0 });
  return <div ref={content}><Page>
    <PageHeader title="数据看板" description="保存项目组合，随时打开查看共同数据的表现，再下钻到结果与产物。"
      actions={<Button asChild variant="primary" icon={<Plus />}><Link to="/dashboard/new" search={{}}>新建看板</Link></Button>} />
    <Card>{dashboards.isPending ? <LoadingBlock /> : dashboards.error ? <div className="p-4"><ErrorBlock error={dashboards.error} onRetry={() => void dashboards.refetch()} /></div> : <DataTable<Dashboard>
      rows={dashboards.data} rowKey={(dashboard) => dashboard.dashboardId}
      searchText={(dashboard) => `${dashboard.name} ${dashboard.description}`} searchPlaceholder="搜索看板名称或说明"
      searchValue={search.dashboardSearch ?? ""}
      onSearchChange={(dashboardSearch) => void navigate({ to: "/dashboard", replace: true, search: (previous) => validateDashboardReadSearch({ ...previous, dashboardSearch: dashboardSearch || undefined, dashboardPage: undefined }) })}
      pagination={{ pageIndex: (search.dashboardPage ?? 1) - 1, onPageChange: (index, replace) => void navigate({ to: "/dashboard", replace, search: (previous) => validateDashboardReadSearch({ ...previous, dashboardPage: index ? index + 1 : undefined }) }) }}
      sorting={{ value: search.dashboardSort ?? [], onChange: (next) => void navigate({
        to: "/dashboard",
        search: (previous) => validateDashboardReadSearch({
          ...previous, dashboardPage: undefined,
          dashboardSort: typeof next === "function" ? next(previous.dashboardSort ?? []) : next,
        }),
      }) }}
      onRowClick={(dashboard) => void navigate({ to: "/dashboard", search: { dashboardId: dashboard.dashboardId } })}
      empty={<EmptyState icon={<LayoutDashboard />} title="还没有保存的看板" description="为项目组合起一个名字。保存后可以反复打开，也能分享当前阅读范围。"
        action={<Button asChild variant="primary"><Link to="/dashboard/new" search={{}}>新建看板</Link></Button>} />}
      columns={[
        { key: "name", header: "看板", sortValue: (dashboard) => dashboard.name, cell: (dashboard) => <div className="min-w-44 py-1"><Link to="/dashboard" search={{ dashboardId: dashboard.dashboardId }} className="font-semibold text-text-strong">{dashboard.name}</Link><p className="mt-1 line-clamp-1 max-w-xl text-xs text-text-muted">{dashboard.description || "暂无说明"}</p></div> },
        { key: "projects", header: "项目", cell: (dashboard) => <span className="whitespace-nowrap tabular-nums">{dashboard.projectIds.length} 个项目</span> },
        { key: "updated", header: "更新时间", sortValue: (dashboard) => dashboard.updatedAt, cell: (dashboard) => <span className="whitespace-nowrap text-xs text-text-muted">{formatDateTime(dashboard.updatedAt)}</span> },
      ]}
    />}</Card>
  </Page></div>;
}
