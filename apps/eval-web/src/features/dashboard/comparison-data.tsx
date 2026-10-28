import { Link } from "@tanstack/react-router";
import { Checkbox, Input, NativeSelect, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@springbrand/site-block";
import { ArrowRight, Search } from "lucide-react";
import { lazy, Suspense } from "react";
import type { ComparisonDataRow, ComparisonProject, ProjectComparisonView } from "@/api-sdk/types";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState, LoadingBlock, Notice } from "@/components/ui/feedback";
import { TablePagination, type useTablePagination } from "@/components/ui/pagination";
import { dataTitle } from "@/features/datasets/dataset-detail-page";
import type { ComparisonViewMode } from "@/features/metrics/comparison-view";
import { comparisonExecutionMetrics, ExecutionMetrics } from "@/features/metrics/execution-metrics";
import { cn } from "@/lib/cn";
import { formatNumber, formatStatistic } from "@/lib/format";
import { ComparisonScore } from "./comparison-summary";
import type { ChangeDashboardSearch, DashboardSearch } from "./dashboard-search";

const SamplingResult = lazy(() => import("@/features/results/sampling-detail-page").then((module) => ({ default: module.SamplingResult })));
export type DataPagination = ReturnType<typeof useTablePagination<ComparisonDataRow>>;

export function DataSearch({ search, onChange, viewMode = "evaluation" }: {
  search: DashboardSearch; onChange: ChangeDashboardSearch; viewMode?: ComparisonViewMode;
}) {
  return <div className="flex min-w-0 flex-wrap items-center gap-3">
    <div className="relative min-w-0 flex-1">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-text-faint" />
      <Input aria-label="搜索共同数据" placeholder="搜索数据名称、任务或 ID" className="h-8 min-w-0 w-full pl-8 text-xs"
        value={search.dataSearch ?? ""} onChange={(event) => onChange({ dataSearch: event.target.value || undefined, dataPage: undefined }, true)} />
    </div>
    {viewMode === "evaluation" && <>
      <label className="flex cursor-pointer items-center gap-2 whitespace-nowrap text-xs text-text-secondary">
        <Checkbox checked={!!search.differences} onCheckedChange={(checked) => onChange({ differences: checked || undefined, dataPage: undefined })} />
        仅评分不同
      </label>
      <label className="flex min-w-0 items-center gap-2 text-xs text-text-secondary"><span>排序</span>
        <NativeSelect aria-label="数据排序" className="min-w-0 max-w-full text-xs" value={search.sort ?? "data"}
          onChange={(event) => onChange({ sort: event.target.value === "difference" ? "difference" : undefined, dataPage: undefined })}>
          <option value="data">数据顺序</option><option value="difference">差异优先</option>
        </NativeSelect>
      </label>
    </>}
  </div>;
}

export function NoMatchingData({ onChange }: { onChange: ChangeDashboardSearch }) {
  return <EmptyState title="没有匹配的共同数据" description="搜索、筛选和排序只影响列表，不改变上方统计。"
    action={<Button size="sm" onClick={() => onChange({ dataSearch: undefined, differences: undefined, dataPage: undefined })}>清空数据筛选</Button>} />;
}

export function ComparisonDataTable({ view, search, onChange, pagination, viewMode = "evaluation" }: {
  view: ProjectComparisonView; search: DashboardSearch; onChange: ChangeDashboardSearch; pagination: DataPagination; viewMode?: ComparisonViewMode;
}) {
  return <Card className="min-w-0">
    <CardHeader title="逐条数据对比" description={viewMode === "evaluation"
      ? "定位评分差异，再打开数据查看各项目的评估理由与产物。数值不同不代表提升。"
      : "仅当前共同已评数据的执行 Agent。积分、耗时为有效采样均值，缺报不按 0 计算。"} className="px-4 py-3" />
    <div className="border-b border-border px-4 py-3"><DataSearch search={search} onChange={onChange} viewMode={viewMode} /></div>
    {!pagination.items.length ? <NoMatchingData onChange={onChange} /> : <Table aria-label="逐条数据对比" className="w-full text-xs" style={{ minWidth: (viewMode === "evaluation" ? 340 : 210) + view.projects.length * 210 }}>
      <TableHeader><TableRow className="bg-surface-muted/60">
        <TableHead className="h-10 min-w-52 px-4 text-xs font-medium">共同数据</TableHead>
        {view.projects.map((meta) => <TableHead key={meta.project.projectId} className="min-w-48 px-4 text-xs font-medium"><span className="line-clamp-2 max-w-52 break-words">{meta.project.name}</span></TableHead>)}
        {viewMode === "evaluation" && <TableHead className="whitespace-nowrap px-4 text-right text-xs font-medium" title="由 Metrics 提供的当前指标差异，不表示胜负或统计显著性">评分差异</TableHead>}
      </TableRow></TableHeader>
      <TableBody>{pagination.items.map((row) => <TableRow key={row.dataId} className="border-b border-border last:border-0 hover:bg-surface-hover">
        <TableCell className="max-w-72 px-4 py-3">
          <Link to="/dashboard" search={{ ...search, dataId: row.dataId, sampling: undefined }} aria-label={`打开 ${dataTitle(row.data)}`}
            className="group flex items-start gap-2 text-left font-semibold leading-5 text-text-strong hover:underline">
            <span className="line-clamp-2 break-words">{dataTitle(row.data)}</span><ArrowRight className="mt-1 size-3 shrink-0 text-text-faint transition-transform group-hover:translate-x-0.5" />
          </Link>
          <p className="mt-1 line-clamp-1 text-[11px] text-text-muted">{row.datasetIds.map((id) => view.datasets.find((dataset) => dataset.datasetId === id)?.name).filter(Boolean).join(" · ")}</p>
          {row.inputChanged && <span className="mt-1 inline-block text-[11px] text-text-muted">冻结输入有差异</span>}
        </TableCell>
        {view.projects.map((meta) => {
          const value = row.projects.find((item) => item.projectId === meta.project.projectId);
          return <TableCell key={meta.project.projectId} className="px-4 py-3 align-top">
            {viewMode === "evaluation" ? <ComparisonScore compact score={value?.score ?? null} />
              : value ? <>
                <ExecutionMetrics value={comparisonExecutionMetrics(value.resources)} average compact />
                <p className="mt-2 text-[11px] tabular-nums text-text-muted">有效采样 {formatNumber(value.samplingCount)} · 有效评估 {formatNumber(value.evaluationCount)}</p>
              </> : <span className="text-xs text-text-muted">未获得</span>}
          </TableCell>;
        })}
        {viewMode === "evaluation" && <TableCell className="px-4 py-3 text-right align-top">
          <span className={cn("inline-block whitespace-nowrap rounded-md px-2 py-1 font-medium", row.different ? "bg-surface-muted text-text-strong ring-1 ring-border" : "text-text-muted")}>{row.different ? "评分不同" : "评分相同"}</span>
          {row.spread !== null && <p className="mt-1.5 tabular-nums text-text-muted">幅度 {formatStatistic(row.spread)}</p>}
        </TableCell>}
      </TableRow>)}</TableBody>
    </Table>}
    <TablePagination {...pagination} label="共同数据分页" />
  </Card>;
}

export function DataNavigation({ search, onChange, pagination, viewMode = "evaluation" }: {
  search: DashboardSearch; onChange: ChangeDashboardSearch; pagination: DataPagination; viewMode?: ComparisonViewMode;
}) {
  return <div aria-label="共同数据导航" className="border-t border-border">
    <div className="space-y-3 px-3 py-3"><h3 className="text-xs font-semibold text-text-strong">共同数据</h3><DataSearch search={search} onChange={onChange} viewMode={viewMode} /></div>
    {!pagination.items.length ? <NoMatchingData onChange={onChange} /> : <nav aria-label="数据列表" className="max-h-[55dvh] overflow-y-auto px-2 pb-2">
      {pagination.items.map((row) => <Link key={row.dataId} to="/dashboard" search={{ ...search, dataId: row.dataId, sampling: undefined }}
        aria-label={`切换到 ${dataTitle(row.data)}`} aria-current={search.dataId === row.dataId ? "page" : undefined}
        className={cn("mb-1 block rounded-md px-2 py-2 text-xs leading-5", search.dataId === row.dataId ? "bg-surface-muted font-semibold text-text-strong ring-1 ring-inset ring-border" : "text-text-secondary hover:bg-surface-hover")}>
        <span className="line-clamp-2 break-words">{dataTitle(row.data)}</span>{viewMode === "evaluation" && <span className="mt-0.5 block text-[11px] font-normal text-text-muted">{row.different ? "评分不同" : "评分相同"}</span>}
      </Link>)}
    </nav>}
    <TablePagination {...pagination} label="数据导航分页" />
  </div>;
}

function ProjectSampling({ project, row, search, onChange, viewMode }: {
  project: ComparisonProject; row: ComparisonDataRow; search: DashboardSearch; onChange: ChangeDashboardSearch; viewMode: ComparisonViewMode;
}) {
  const projectId = project.project.projectId;
  const values = row.projects.find((item) => item.projectId === projectId);
  const ids = values?.samplingIds ?? [];
  const requested = search.sampling?.[projectId];
  const samplingId = requested && ids.includes(requested) ? requested : ids[0];
  return <section aria-label={`${project.project.name} 结果`} className="min-w-0 overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface">
    <div className="space-y-3 border-b border-border px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="min-w-0 break-words text-sm font-semibold text-text-strong">{project.project.name}</h3>
        {samplingId && <Link className="link text-[11px]" to="/projects/$projectId/samplings/$samplingId" params={{ projectId, samplingId }}>独立打开</Link>}
      </div>
      <label className="block space-y-1.5"><span className="text-xs text-text-muted">有效采样 · 各项目独立选择</span>
        <NativeSelect aria-label={`${project.project.name} 的有效采样`} className="w-full min-w-0 max-w-full font-mono text-xs" value={samplingId ?? ""}
          onChange={(event) => onChange({ sampling: { ...search.sampling, [projectId]: event.target.value } })}>
          {ids.map((id) => <option key={id} value={id}>采样 · {id}</option>)}
        </NativeSelect>
      </label>
      {requested && requested !== samplingId && <p className="text-xs text-text-muted">此前选择已不在当前有效采样范围，现展示当前有效采样。</p>}
    </div>
    <div className="min-w-0 p-3">
      {samplingId ? <Suspense fallback={<LoadingBlock />}><SamplingResult key={`${projectId}:${samplingId}`} projectId={projectId} samplingId={samplingId} presentation="comparison" comparisonViewMode={viewMode} /></Suspense>
        : <Notice tone="neutral">当前数据未提供有效采样，请刷新对比范围。</Notice>}
    </div>
  </section>;
}

export function ComparisonDataResults({ view, row, search, onChange, viewMode = "evaluation" }: {
  view: ProjectComparisonView; row: ComparisonDataRow; search: DashboardSearch; onChange: ChangeDashboardSearch; viewMode?: ComparisonViewMode;
}) {
  return <section aria-label="并排结果与产物" className="min-w-0 space-y-3">
    <div className="px-0.5"><h2 className="text-sm font-semibold text-text-strong">结果与产物</h2><p className="mt-1 text-xs leading-5 text-text-muted">各项目分别选择有效采样。采样 ID 或展示顺序不代表配对关系；产物是主要证据，过程用于辅助排查。</p></div>
    {row.inputChanged && <Notice tone="neutral">这条数据在各项目中冻结的输入有差异。请结合各侧的“执行任务与评估要求”阅读，不将分数差异直接解释为提升。</Notice>}
    <div className="min-w-0 overflow-x-auto overscroll-x-contain pb-2" tabIndex={0} aria-label="采样结果并排阅读区域">
      <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-flow-col md:auto-cols-[minmax(360px,1fr)] md:grid-cols-none">
        {view.projects.map((project) => <ProjectSampling key={project.project.projectId} project={project} row={row} search={search} onChange={onChange} viewMode={viewMode} />)}
      </div>
    </div>
  </section>;
}
