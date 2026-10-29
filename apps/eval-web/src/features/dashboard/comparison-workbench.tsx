import { Link } from "@tanstack/react-router";
import { NativeSelect } from "@springbrand/site-block";
import { ChevronDown, ChevronRight, Database, Layers3 } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import type { ProjectComparisonView } from "@/api-sdk/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { useTablePagination } from "@/components/ui/pagination";
import { dataTitle } from "@/features/datasets/dataset-detail-page";
import { ComparisonViewSwitch } from "@/features/metrics/comparison-view";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { ComparisonDataResults, ComparisonDataTable, DataNavigation } from "./comparison-data";
import { ComparisonSummary } from "./comparison-summary";
import { clearedDataScope, type ChangeDashboardSearch, type DashboardSearch } from "./dashboard-search";
import { DataSelectionActions, type DataSelection } from "./data-selection";

function ScopeNavigation({ view, search, children }: { view: ProjectComparisonView; search: DashboardSearch; children?: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const navigationId = useId();
  const currentDataset = view.datasets.find((dataset) => dataset.datasetId === search.datasetId);
  const currentData = view.rows.find((row) => row.dataId === search.dataId);
  return <Card className="min-w-0 self-start lg:sticky lg:top-24">
    <div className="flex items-center justify-between gap-2 px-3 pb-3 pt-4">
      <div className="min-w-0"><h2 className="text-xs font-semibold text-text-strong">对比范围</h2>
        <p className="mt-1 line-clamp-2 break-words text-[11px] leading-5 text-text-muted">{currentData ? dataTitle(currentData.data) : currentDataset?.name ?? (search.datasetId ? "所选数据集" : "全部共同数据")}</p>
      </div>
      <Button size="xs" variant="ghost" aria-label="切换范围和数据导航" aria-expanded={expanded} aria-controls={navigationId}
        className="lg:hidden" onClick={() => setExpanded(!expanded)}>{expanded ? "收起导航" : search.dataId ? "切换数据" : "切换范围"}<ChevronDown className={cn("size-3", expanded && "rotate-180")} /></Button>
    </div>
    <div id={navigationId} className={cn(!expanded && "hidden lg:block")}>
    <nav aria-label="数据集范围" className="max-h-72 space-y-1 overflow-y-auto px-2 pb-3">
      <Link to="/dashboard" search={{ ...search, ...clearedDataScope, datasetId: undefined }} aria-label="范围 全部共同数据" aria-current={!search.datasetId && !search.dataId ? "page" : undefined}
        className={cn("flex items-center gap-2 rounded-md px-2 py-2.5 text-xs", !search.datasetId ? "bg-surface-muted font-semibold text-text-strong" : "text-text-secondary hover:bg-surface-hover")}>
        <Layers3 className="size-3.5 shrink-0 text-text-muted" /><span className="min-w-0 flex-1">全部共同数据</span><span className="tabular-nums text-text-muted">{formatNumber(view.selectedField?.dataCount ?? 0)}</span>
      </Link>
      {view.datasets.map((dataset) => <Link key={dataset.datasetId} to="/dashboard"
        search={{ ...search, ...clearedDataScope, datasetId: dataset.datasetId }} aria-label={`范围 ${dataset.name}`} aria-current={search.datasetId === dataset.datasetId && !search.dataId ? "page" : undefined}
        className={cn("flex items-start gap-2 rounded-md px-2 py-2 text-xs leading-5", search.datasetId === dataset.datasetId ? "bg-surface-muted font-semibold text-text-strong" : "text-text-secondary hover:bg-surface-hover")}>
        <Database className="mt-0.5 size-3.5 shrink-0 text-text-muted" /><span className="min-w-0 flex-1 break-words">{dataset.name}</span><span className="tabular-nums text-text-muted">{formatNumber(dataset.dataCount)}</span>
      </Link>)}
    </nav>
    {children}
    <p className="border-t border-border px-3 py-3 text-[11px] leading-5 text-text-muted">数据集可重叠，全部数据只计一次。</p>
    </div>
  </Card>;
}

export function ComparisonWorkbench({ view, search, onChange, onRemove, selection }: {
  view: ProjectComparisonView; search: DashboardSearch; onChange: ChangeDashboardSearch; onRemove: (projectId: string) => void; selection?: DataSelection;
}) {
  const field = view.selectedField;
  const viewMode = search.viewMode ?? "evaluation";
  const evaluating = viewMode === "evaluation";
  const metricHintId = useId();
  const dataset = view.datasets.find((item) => item.datasetId === search.datasetId);
  const row = view.rows.find((item) => item.dataId === search.dataId);
  const term = (search.dataSearch ?? "").trim().toLocaleLowerCase();
  const filtered = view.rows.filter((item) => (!evaluating || !search.differences || item.different)
    && (!term || `${dataTitle(item.data)} ${item.data.userPrompt} ${item.dataId}`.toLocaleLowerCase().includes(term)));
  const numeric = field?.kinds.some((kind) => kind === "number" || kind === "integer");
  const ordered = evaluating && search.sort === "difference" ? filtered.toSorted((left, right) => {
    if (!numeric) return Number(right.different) - Number(left.different);
    if (left.spread === null) return right.spread === null ? 0 : 1;
    if (right.spread === null) return -1;
    return right.spread - left.spread;
  }) : filtered;
  const pagination = useTablePagination(ordered, "", {
    pageIndex: (search.dataPage ?? 1) - 1,
    onPageChange: (index, replace) => onChange({ dataPage: index ? index + 1 : undefined }, replace),
  });
  const scope = search.datasetId ? dataset?.name ?? "所选数据集" : "全部共同数据";
  const scopeTitle = search.dataId ? row ? dataTitle(row.data) : "所选数据" : scope;
  const scopeDataCount = (search.dataId ? row?.projects : view.summary)?.[0]?.dataCount ?? 0;
  const noFields = !field;
  const unavailableMetric = noFields && (search.jsonPointer !== undefined || view.fields.length > 0);
  return <div className="min-w-0 space-y-4">
    <section aria-label="对比视图与范围" className="min-w-0 space-y-2.5">
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-5">
        <ComparisonViewSwitch value={viewMode} onChange={(value) => onChange({ viewMode: value === "execution" ? "execution" : undefined })} />
        <p aria-label="当前共同数据范围" className="min-w-0 break-words text-xs leading-5 text-text-muted">
          <span className="font-medium tabular-nums text-text-secondary">{formatNumber(scopeDataCount)} 条共同已评数据</span><span aria-hidden="true" className="mx-1.5">·</span>{scopeTitle}
        </p>
      </div>
      {evaluating && (field || view.fields.length > 0) && <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <label className="flex w-full min-w-0 items-center gap-2 sm:w-auto"><span className="shrink-0 text-xs font-medium text-text-secondary">共同指标</span>
          <NativeSelect aria-label="共同指标" aria-describedby={metricHintId} className="min-w-0 flex-1 sm:w-64 sm:flex-none [&_select]:text-xs" value={field?.jsonPointer ?? "__unscored_metric__"}
            onChange={(event) => onChange({ ...clearedDataScope, datasetId: undefined, jsonPointer: event.target.value })}>
            {!field && <option value="__unscored_metric__" disabled>当前指标暂无共同评分</option>}
            {view.fields.map((item) => <option key={item.jsonPointer} value={item.jsonPointer}>{item.title} · {formatNumber(item.dataCount)} 条共同数据</option>)}
          </NativeSelect>
        </label>
        <p id={metricHintId} className="text-[11px] leading-5 text-text-muted">切换评估项会回到全部共同数据。</p>
      </div>}
      {!evaluating && field && <p className="break-words text-[11px] leading-5 text-text-muted">沿用「{field.title}」下的共同已评数据，不含项目中其他数据。</p>}
    </section>
    {selection && <DataSelectionActions selection={selection} />}
    {noFields ? <Card>
      <div className="flex flex-wrap gap-x-6 gap-y-2 border-b border-border px-5 py-4">{view.projects.map((meta) =>
        <div key={meta.project.projectId}><p className="text-sm font-semibold text-text-strong">{meta.project.name}</p><p className="mt-1 text-xs text-text-muted">执行 Agent · {meta.executionAgentName} · {meta.executionModel ?? meta.framework.toUpperCase()}</p><p className="mt-1 text-xs text-text-muted">评估 Agent · {meta.evaluationAgentName ?? "未提供"}</p></div>)}</div>
      <EmptyState title={unavailableMetric ? "当前指标暂无共同评分" : "暂无共同已评数据"}
        description={unavailableMetric
          ? !evaluating ? "当前评估项暂无共同有效评分，执行指标仍沿用同一范围。可切换到评估指标重新选择，不会自动更换评估项或数据范围。"
            : view.fields.length > 0 ? "所选项目在当前指标上暂无共同有效评分。可直接切换上方的其他共同指标继续查看。" : "所选项目在当前指标上暂无共同有效评分。可稍后刷新结果，或调整项目。"
          : "所选项目还没有在同一共同指标上都取得有效评分的数据。真实的 0 和 false 会保留；未评分、null、失败结果不进入默认对比。"}
        action={(!evaluating && unavailableMetric) || view.fields.length === 0 ? <div className="flex flex-wrap justify-center gap-2">
          {!evaluating && unavailableMetric && <Button onClick={() => onChange({ viewMode: undefined })}>切换到评估指标</Button>}
          {view.fields.length === 0 && <Button asChild><Link to="/dashboard/edit" search={{ ...search }}>编辑看板</Link></Button>}
        </div> : undefined} />
    </Card> : <>
      <nav aria-label="对比路径" className="flex min-w-0 flex-wrap items-center gap-1.5 px-1 text-xs text-text-muted">
        <Link to="/dashboard/edit" search={{ ...search }} className="hover:text-text-strong">已选 {search.projectId.length} 个项目</Link><ChevronRight className="size-3" />
        <Link to="/dashboard" aria-label="返回全部共同数据" search={{ ...search, ...clearedDataScope, datasetId: undefined }} className="hover:text-text-strong">全部共同数据</Link>
        {search.datasetId && <><ChevronRight className="size-3" /><Link to="/dashboard" aria-label="返回当前数据集" search={{ ...search, dataId: undefined, sampling: undefined }} className="max-w-full break-words hover:text-text-strong">{scope}</Link></>}
        {search.dataId && <><ChevronRight className="size-3" /><span className="min-w-0 break-words font-medium text-text-strong" aria-current="page">{row ? dataTitle(row.data) : "当前数据"}</span></>}
      </nav>
      <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
        <ScopeNavigation key={JSON.stringify([field.jsonPointer, search.datasetId, search.dataId])} view={view} search={search}>{search.dataId && <DataNavigation search={search} onChange={onChange} pagination={pagination} viewMode={viewMode} />}</ScopeNavigation>
        <div className="min-w-0 space-y-4">
          {search.dataId && !row ? <Card><EmptyState title="这条数据已不在当前共同已评范围" description="结果可能已重跑或被替换。返回当前范围，选择仍然具有共同有效评分的数据。"
            action={<Button onClick={() => onChange({ dataId: undefined, sampling: undefined })}>返回当前范围</Button>} /></Card>
            : !view.rows.length ? <Card><EmptyState title="当前范围暂无共同已评数据" description="当前指标在这个范围中没有可共同对比的有效评分。可回到全部共同数据，或切换共同指标。"
              action={<Button onClick={() => onChange({ ...clearedDataScope, datasetId: undefined })}>返回全部共同数据</Button>} /></Card>
              : <>
              <ComparisonSummary projects={view.projects} values={row ? row.projects : view.summary}
                title={row ? "单条数据表现" : search.datasetId ? "数据集表现" : "整体差异"}
                scope={<>{field.title} · {row ? dataTitle(row.data) : scope}</>} onRemove={onRemove} viewMode={viewMode} />
              {row ? <ComparisonDataResults view={view} row={row} search={search} onChange={onChange} viewMode={viewMode} />
                : <ComparisonDataTable view={view} search={search} onChange={onChange} pagination={pagination} viewMode={viewMode} selection={selection} />}
            </>}
        </div>
      </div>
    </>}
    <p className="px-1 text-[11px] leading-5 text-text-muted">仅比较当前留存的共同有效评分。0 和 false 是有效值，未评分、null 与失败不作为 0；并排列值不代表评分规则相同或统计显著。</p>
  </div>;
}
