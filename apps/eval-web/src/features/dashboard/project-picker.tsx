import { useQuery } from "@tanstack/react-query";
import { Check, FlaskConical, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { listProjects, projectKeys } from "@/api-sdk/projects-api";
import type { Project } from "@/api-sdk/types";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState, ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
import { formatDateTime } from "@/lib/format";
import { clearedComparisonScope, type ChangeDashboardSearch, type DashboardSearch } from "./dashboard-search";

export function ProjectPicker({ search, onChange, limit, disabled = false, action }: {
  search: DashboardSearch; onChange: ChangeDashboardSearch; limit: number; disabled?: boolean; action: (ready: boolean) => ReactNode;
}) {
  const projects = useQuery({ queryKey: projectKeys.list(), queryFn: ({ signal }) => listProjects(signal) });
  const selected = useMemo(() => new Set(search.projectId), [search.projectId]);
  const [selectionError, setSelectionError] = useState("");
  const names = new Map(projects.data?.map((project) => [project.projectId, project.name]));
  const select = (next: Set<string>) => {
    if (disabled) return;
    if (next.size > limit && next.size > selected.size) {
      setSelectionError(`本次最多选择 ${limit} 个项目，请先移除部分选择。`);
      return;
    }
    setSelectionError("");
    onChange({ ...clearedComparisonScope, projectId: [...next] });
  };
  const ready = selected.size >= 2 && selected.size <= limit;
  const unavailable = !ready || !projects.data || !!projects.error;
  return <Card>
    <CardHeader title="选择要对比的项目" description={`至少选择 2 个，最多 ${limit} 个。支持搜索和跨页勾选。`}
      actions={<span className="text-xs tabular-nums text-text-muted">已选 {selected.size} / {limit}</span>} />
    <fieldset disabled={disabled} className="min-w-0 border-0 p-0">
    {search.projectId.length > 0 && <div aria-label="已选项目" className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-muted/40 px-4 py-3">
      <span className="mr-1 text-xs font-medium tabular-nums text-text-muted">已选 {selected.size} / {limit}</span>
      {search.projectId.map((id) => <button key={id} type="button" aria-label={`移除 ${names.get(id) ?? id}`} onClick={() => select(new Set(search.projectId.filter((item) => item !== id)))}
        className="inline-flex max-w-full items-center gap-2 rounded-md border border-border bg-surface px-2 py-1 text-xs font-medium text-text-strong hover:bg-surface-hover">
        <Check className="size-3 shrink-0 text-text-muted" /><span className="truncate">{names.get(id) ?? `不可用项目 · ${id}`}</span><X className="size-3 shrink-0 text-text-muted" />
      </button>)}
      <Button size="xs" variant="ghost" onClick={() => select(new Set())}>清空选择</Button>
    </div>}
    {(selectionError || selected.size > limit) && <p role="alert" className="border-b border-border px-4 py-3 text-xs text-danger">{selectionError || `当前选择超过 ${limit} 个项目，请移除部分选择后继续。`}</p>}
    {projects.isPending ? <LoadingBlock /> : projects.error ? <div className="p-4"><ErrorBlock error={projects.error} onRetry={() => void projects.refetch()} /></div> : <DataTable<Project>
      rows={projects.data} rowKey={(project) => project.projectId} rowLabel={(project) => project.name}
      searchText={(project) => `${project.name} ${project.description ?? ""} ${project.sourceBranch}`}
      searchPlaceholder="搜索对比项目" searchValue={search.projectSearch ?? ""}
      onSearchChange={(projectSearch) => { if (!disabled) onChange({ projectSearch: projectSearch || undefined, projectPage: undefined }, true); }}
      pagination={{ pageIndex: (search.projectPage ?? 1) - 1, onPageChange: (index, replace) => { if (!disabled) onChange({ projectPage: index ? index + 1 : undefined }, replace); } }}
      selectable selected={selected} onSelectedChange={select}
      empty={<EmptyState icon={<FlaskConical />} title="还没有可选择的项目" description="在项目管理中完成执行与评估后，即可在这里查看共同数据的表现。" />}
      columns={[
        { key: "name", header: "项目", cell: (project) => <div className="min-w-44 py-1"><span className="font-semibold text-text-strong">{project.name}</span><p className="mt-1 line-clamp-1 max-w-lg text-xs text-text-muted">{project.description || "暂无说明"}</p></div>, sortValue: (project) => project.name },
        { key: "branch", header: "SP 分支", cell: (project) => <span className="font-mono text-xs text-text-secondary">{project.sourceBranch}</span> },
        { key: "created", header: "创建时间", cell: (project) => <span className="whitespace-nowrap text-xs text-text-muted">{formatDateTime(project.createdAt)}</span>, sortValue: (project) => project.createdAt },
      ]}
    />}
    </fieldset><div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface-muted/30 px-4 py-4">
      <p className="text-xs leading-5 text-text-muted">{selected.size < 2 ? "再选择项目，至少 2 个即可开始。" : `已选择 ${selected.size} 个项目 · 仅查看各项目都有有效评分的共同数据`}</p>
      {action(!unavailable)}
    </div>
  </Card>;
}
