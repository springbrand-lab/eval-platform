import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Input } from "@springbrand/site-block";
import type { ProjectView, RunTargetSelector } from "@/api-sdk/types";
import { getSampleOverview, getSamplingDetail, metricKeys } from "@/api-sdk/metrics-api";
import { HierarchyBranch, HierarchyPicker } from "@/components/ui/hierarchy-picker";
import { ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
import { StatusBadge } from "@/components/ui/badge";
import { dataTitle } from "@/features/datasets/dataset-detail-page";

function SamplingChoices({ projectId, sampleId, selected, inherited, disabled, onLoaded, onSelect }: {
  projectId: string; sampleId: string; selected: ReadonlySet<string>; inherited: boolean; disabled: boolean;
  onLoaded: (sampleId: string, ids: readonly string[]) => void; onSelect: (id: string, checked: boolean) => void;
}) {
  const query = useQuery({ queryKey: metricKeys.sample(projectId, sampleId, []),
    queryFn: ({ signal }) => getSampleOverview(projectId, sampleId, [], signal) });
  useEffect(() => {
    if (query.data) onLoaded(sampleId, query.data.samplings.map((sampling) => sampling.samplingId));
  }, [query.data, sampleId, onLoaded]);
  if (query.isPending) return <LoadingBlock rows={2} />;
  if (query.error) return <ErrorBlock error={query.error} onRetry={() => void query.refetch()} />;
  return query.data.samplings.length === 0 ? <p className="p-3 text-xs text-text-muted">还没有采样；可勾选上级用例，按配置创建采样。</p> : query.data.samplings.map((sampling, index) => (
    <HierarchyBranch key={sampling.samplingId} label={`采样 ${index + 1} · ${sampling.samplingId}`}
      detail={<StatusBadge status={sampling.execution.status} />} checked={inherited || selected.has(sampling.samplingId)}
      disabled={disabled || inherited} onCheckedChange={(checked) => onSelect(sampling.samplingId, checked)} />
  ));
}

export function RunScopePicker({ project, value, onChange, disabled, initialSamplingId }: {
  project: ProjectView; value: RunTargetSelector; onChange: (next: RunTargetSelector) => void; disabled: boolean; initialSamplingId?: string;
}) {
  const [search, setSearch] = useState("");
  const [owners, setOwners] = useState<ReadonlyMap<string, string>>(new Map());
  const resolvingInitial = !!initialSamplingId && !!value.samplingIds?.includes(initialSamplingId);
  const initialSampling = useQuery({ queryKey: metricKeys.sampling(project.project.projectId, initialSamplingId ?? ""),
    queryFn: ({ signal }) => getSamplingDetail(project.project.projectId, initialSamplingId!, signal), enabled: resolvingInitial });
  const owner = (id: string) => owners.get(id) ?? (id === initialSamplingId ? initialSampling.data?.projectSample.projectSampleId : undefined);
  const register = useCallback((sampleId: string, ids: readonly string[]) => setOwners((current) => {
    if (ids.every((id) => current.get(id) === sampleId)) return current;
    const next = new Map(current);
    for (const id of ids) next.set(id, sampleId);
    return next;
  }), []);
  const datasets = new Set(value.datasetIds);
  const samples = new Set(value.projectSampleIds);
  const samplings = new Set(value.samplingIds);
  const inheritedSamples = new Set(project.datasets.filter((dataset) => datasets.has(dataset.datasetId)).flatMap((dataset) => dataset.projectSampleIds));
  const sampledCases = new Set([...samplings].map(owner).filter((id): id is string => !!id));
  const query = search.trim().toLowerCase();
  const sampleById = new Map(project.projectSamples.map((sample) => [sample.projectSampleId, sample]));
  const update = (key: "datasetIds" | "projectSampleIds" | "samplingIds", id: string, checked: boolean) => {
    if (disabled) return;
    const ids = new Set(value[key]);
    if (checked) ids.add(id); else ids.delete(id);
    const next = { ...value, [key]: [...ids].sort() };
    if (checked && key !== "samplingIds") {
      const children = new Set(key === "datasetIds" ? project.datasets.find((dataset) => dataset.datasetId === id)?.projectSampleIds : [id]);
      if (key === "datasetIds") next.projectSampleIds = [...samples].filter((sample) => !children.has(sample));
      next.samplingIds = [...samplings].filter((sampling) => !children.has(owner(sampling) ?? ""));
    }
    onChange(next);
  };
  const summary = value.all ? `整个项目 · ${project.projectSamples.length} 条用例` : [
    datasets.size > 0 && `${datasets.size} 个测试集`, samples.size > 0 && `${samples.size} 条用例`, samplings.size > 0 && `${samplings.size} 个采样`,
  ].filter(Boolean).join(" · ") || "请选择运行范围";
  const visible = project.datasets.map((dataset) => {
    const matches = `${dataset.name} ${dataset.description ?? ""}`.toLowerCase().includes(query);
    const cases = dataset.projectSampleIds.flatMap((id) => {
      const sample = sampleById.get(id);
      return sample && (matches || `${dataTitle(sample.data)} ${sample.projectSampleId}`.toLowerCase().includes(query)) ? [sample] : [];
    });
    return { dataset, cases, matches };
  }).filter(({ matches, cases }) => matches || cases.length > 0);
  return <div className="flex flex-col gap-3">
    <HierarchyPicker summary={summary} disabled={disabled} path="项目 → 测试集 → 用例 → 已有采样">
      <div className="flex items-center gap-2 border-b border-border p-3">
        <Input aria-label="搜索测试集或用例" placeholder="搜索测试集或用例" value={search} disabled={disabled} onChange={(event) => setSearch(event.target.value)} />
        <Button type="button" variant="ghost" size="sm" disabled={disabled || (!value.all && !datasets.size && !samples.size && !samplings.size)} onClick={() => !disabled && onChange({})}>清空选择</Button>
      </div>
      <div className="max-h-[min(55vh,28rem)] overflow-y-auto p-2">
        <HierarchyBranch label={project.project.name} detail="项目 · 勾选后包含全部用例" defaultOpen forceOpen={!!query}
          checked={value.all || (datasets.size + samples.size + samplings.size > 0 ? "indeterminate" : false)} disabled={disabled}
          onCheckedChange={(checked) => !disabled && onChange(checked ? { all: true } : {})}>
          {visible.map(({ dataset, cases }) => {
            const inherited = !!value.all;
            const full = inherited || datasets.has(dataset.datasetId);
            const partial = dataset.projectSampleIds.some((id) => samples.has(id) || inheritedSamples.has(id) || sampledCases.has(id));
            return <HierarchyBranch key={dataset.datasetId} label={dataset.name} detail={`测试集 · ${dataset.projectSampleIds.length} 条用例`}
              forceOpen={!!query} checked={full || (partial ? "indeterminate" : false)} disabled={disabled || inherited}
              onCheckedChange={(checked) => update("datasetIds", dataset.datasetId, checked)}>
              {cases.map((sample) => {
                const covered = !!value.all || inheritedSamples.has(sample.projectSampleId);
                const selected = covered || samples.has(sample.projectSampleId);
                return <HierarchyBranch key={sample.projectSampleId} label={dataTitle(sample.data)}
                  detail={`用例 · 配置 ${sample.samplingCount} 次采样${covered ? " · 已由上级包含" : ""}`}
                  checked={selected || (sampledCases.has(sample.projectSampleId) ? "indeterminate" : false)} disabled={disabled || covered}
                  onCheckedChange={(checked) => update("projectSampleIds", sample.projectSampleId, checked)}>
                  <SamplingChoices projectId={project.project.projectId} sampleId={sample.projectSampleId} selected={samplings}
                    inherited={selected} disabled={disabled} onLoaded={register} onSelect={(id, checked) => update("samplingIds", id, checked)} />
                </HierarchyBranch>;
              })}
            </HierarchyBranch>;
          })}
          {visible.length === 0 && <p className="p-3 text-sm text-text-muted">没有匹配的测试集或用例。</p>}
        </HierarchyBranch>
      </div>
      <div className="border-t border-border bg-surface-muted/50 px-4 py-3 text-xs leading-5 text-text-muted">
        勾选上级包含全部下级；要选择部分，请先取消上级勾选。半选表示已选下级。共享用例和采样由服务端预览去重。
      </div>
    </HierarchyPicker>
    <p aria-live="polite" className="text-sm font-medium text-text-strong">{summary}</p>
    {!!samplings.size && <details className="text-xs text-text-muted">
      <summary className="cursor-pointer">查看已选采样（{samplings.size}）</summary>
      <div className="mt-2 flex max-h-32 flex-wrap gap-2 overflow-y-auto">{[...samplings].map((id) => (
        <Button key={id} type="button" variant="outline" size="sm" className="max-w-full" title={id} aria-label={`移除采样 ${id}`}
          disabled={disabled} onClick={() => update("samplingIds", id, false)}><span className="truncate font-mono text-xs">{id}</span> ×</Button>
      ))}</div>
    </details>}
    {resolvingInitial && initialSampling.error && <ErrorBlock error={initialSampling.error} onRetry={() => void initialSampling.refetch()} />}
    <p className="text-xs leading-5 text-text-muted">选择的是运行范围，不是实际提交数量。勾选用例按配置次数运行；只勾选采样仅作用于指定采样。请预览后确认。</p>
  </div>;
}
