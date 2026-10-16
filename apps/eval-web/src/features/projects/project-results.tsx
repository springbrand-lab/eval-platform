import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, NativeSelect } from "@springbrand/site-block";
import { Fragment, lazy, Suspense, useState } from "react";
import type { ProjectOverview, ProjectView, OutputFieldSummary, EvaluationOutputSummary, MetricSummary } from "@/api-sdk/types";
import { getSampleOverview, metricKeys } from "@/api-sdk/metrics-api";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/form";
import { StatusBadge } from "@/components/ui/badge";
import { ErrorBlock, LoadingBlock, EmptyState } from "@/components/ui/feedback";
import { formatDuration, formatStatistic } from "@/lib/format";
import { dataTitle } from "@/features/datasets/dataset-detail-page";
const SamplingResult = lazy(() => import("@/features/results/sampling-detail-page").then((module) => ({ default: module.SamplingResult })));
import { POLL_MS } from "@/features/runs/use-run-polling";

type Row = ProjectOverview["projectSamples"][number];
export function needsAttention(row: Row): boolean {
  return row.summary.execution.statuses.failed + row.summary.execution.statuses.cancelled > 0 || row.summary.evaluation.statuses.failed + row.summary.evaluation.statuses.cancelled > 0 || row.summary.evaluationOutputs.validation.invalid > 0;
}
export function metricLabel(field: OutputFieldSummary): string {
  if (field.title !== field.jsonPointer) return field.title;
  return ({ "/score": "分数", "/passed": "是否通过", "/reason": "评估理由" } as Record<string, string>)[field.jsonPointer] ?? field.title;
}
export function MetricCell({ field }: { field?: OutputFieldSummary }) {
  if (!field || field.observationCount === 0) return <span className="text-text-muted" title="没有有效评估值">—</span>;
  const value = field.numeric?.count ? formatStatistic(field.numeric.mean)
    : field.distribution.filter((item) => item.count > 0).map((item) => `${item.value === true ? "是" : item.value === false ? "否" : String(item.value)}${field.observationCount > 1 ? ` ×${item.count}` : ""}`).join("、") || (field.nullCount ? "空值" : "—");
  return <div className="tabular-nums"><span className="font-medium text-text-strong">{value}</span>
    {field.numeric && field.numeric.count > 1 && <span className="block whitespace-nowrap text-[11px] text-text-muted" title={`均值 ${value}；范围 ${formatStatistic(field.numeric.min)} 至 ${formatStatistic(field.numeric.max)}；${field.numeric.count} 个有效值`}>{formatStatistic(field.numeric.min)}–{formatStatistic(field.numeric.max)} · n={field.numeric.count}</span>}
    {field.missingEvaluationCount > 0 && <span className="ml-1 text-[11px] text-warning" title={`${field.missingEvaluationCount} 份评估未贡献此字段的有效值`}>缺{field.missingEvaluationCount}</span>}
  </div>;
}
const cellClass = "h-12 px-3 py-2 align-middle text-xs";
export function ResultCost({ summary }: { summary: MetricSummary }) {
  const costs = [summary.executionAgent.costs.chargedUnits, summary.evaluationAgents.costs.chargedUnits];
  const stages = [summary.execution, summary.evaluation].filter((stage) => stage.records > 0);
  const costKnown = costs.every((cost, index) => cost.value !== null || [summary.execution, summary.evaluation][index]!.records === 0);
  const durationKnown = stages.length > 0 && stages.every((stage) => stage.agentDurationMs.total !== null);
  const partial = costs.some((cost) => cost.coverage === "partial") || stages.some((stage) => stage.agentDurationMs.missing > 0);
  return <div className="whitespace-nowrap tabular-nums" title="执行与评估合计；耗时为 Agent 累计耗时，不是并行运行的墙钟时间。部分数据会标注。">
    <span>{costKnown && stages.length ? `${formatStatistic(costs.reduce((sum, cost) => sum + (cost.value ?? 0), 0))} 积分` : "积分未获得"}</span>
    <span className="block text-[11px] text-text-muted">{durationKnown ? formatDuration(stages.reduce((sum, stage) => sum + (stage.agentDurationMs.total ?? 0), 0)) : "耗时未获得"}{partial ? " · 部分" : ""}</span>
  </div>;
}
function MetricCells({ outputs, fields }: { outputs: EvaluationOutputSummary; fields: readonly OutputFieldSummary[] }) {
  return fields.map((field) => <TableCell key={field.jsonPointer} className={`${cellClass} text-right`}><MetricCell field={outputs.fields.find((item) => item.jsonPointer === field.jsonPointer)} /></TableCell>);
}
function SamplingRows({ projectId, sampleId, running, fields, onOpen }: { projectId: string; sampleId: string; running: boolean; fields: readonly OutputFieldSummary[]; onOpen: (id: string) => void }) {
  const result = useQuery({ queryKey: metricKeys.sample(projectId, sampleId, []), queryFn: ({ signal }) => getSampleOverview(projectId, sampleId, [], signal), staleTime: 0, refetchInterval: running ? POLL_MS : false });
  if (result.error || !result.data) return <TableRow><TableCell colSpan={fields.length + 5} className="px-4 py-2">{result.error ? <ErrorBlock error={result.error} onRetry={() => void result.refetch()} /> : <LoadingBlock rows={1} />}</TableCell></TableRow>;
  return result.data.samplings.map((row, index) => <TableRow key={row.samplingId} className="border-b border-border bg-surface-muted/40">
    <TableCell className={`${cellClass} pl-8`}><button className="text-left hover:underline" onClick={() => onOpen(row.samplingId)}>采样 {index + 1}</button><span className="ml-2 text-[10px] font-mono text-text-faint">{row.samplingId.slice(0, 8)}</span></TableCell>
    <TableCell className={cellClass}><StatusBadge status={row.execution.status} /></TableCell>
    <TableCell className={cellClass}>{row.summary.evaluationOutputs.validation.valid}/{row.summary.counts.evaluations}
      {row.summary.evaluation.statuses.failed > 0 && <span className="block text-[11px] text-danger">评估失败</span>}
      {row.summary.evaluation.statuses.cancelled > 0 && <span className="block text-[11px] text-text-muted">已取消</span>}
    </TableCell>
    <MetricCells outputs={row.summary.evaluationOutputs} fields={fields} /><TableCell className={`${cellClass} text-right`}><ResultCost summary={row.summary} /></TableCell>
    <TableCell className={`${cellClass} text-right`}><button className="link whitespace-nowrap font-medium" onClick={() => onOpen(row.samplingId)}>查看结果</button></TableCell>
  </TableRow>);
}
export function ProjectResults({ projectId, view, overview }: { projectId: string; view: ProjectView; overview: ProjectOverview }) {
  const [dataset, setDataset] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [metric, setMetric] = useState("__all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sampling, setSampling] = useState<string | null>(null);
  const fields = overview.summary.evaluationOutputs.fields;
  const selectedMetric = metric === "__all" || fields.some((field) => field.jsonPointer === metric) ? metric : "__all";
  const visibleFields = selectedMetric === "__all" ? fields : fields.filter((field) => field.jsonPointer === selectedMetric);
  const samples = new Map(view.projectSamples.map((sample) => [sample.projectSampleId, sample]));
  const rows = overview.projectSamples.filter((row) => (!dataset || row.datasetIds.includes(dataset))
    && (!query.trim() || dataTitle(samples.get(row.projectSampleId)!.data).toLowerCase().includes(query.trim().toLowerCase()))
    && (filter === "all" || (filter === "attention" ? needsAttention(row) : filter === "not-run" ? !row.samplingIds.length : filter === "missing" ? row.summary.evaluationOutputs.validation.unavailable > 0 : filter === "unscored" ? (row.summary.evaluationOutputs.validation.valid === 0 || row.summary.evaluationOutputs.validation.unavailable > 0) : row.summary.execution.records > row.summary.execution.terminalRecords)));
  const summary = overview.summary;
  const focusResults = (next: string) => { setFilter(next); setQuery(""); setDataset(""); };
  return <>
    <div aria-label="结果摘要" className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md border border-border bg-surface px-3 py-2 text-xs text-text-muted">
      <span>用例 <strong className="text-text-strong">{summary.counts.projectSamples}</strong> · 采样 {summary.counts.samplings}</span>
      <span title="执行成功不代表质量达标">执行完成 <strong className="text-text-strong">{summary.execution.statuses.succeeded}/{summary.execution.records}</strong></span>
      <button className="hover:underline" onClick={() => focusResults("attention")}>异常用例 {overview.projectSamples.filter(needsAttention).length}</button>
      <button className="hover:underline" onClick={() => focusResults("running")}>未结束 {summary.execution.records - summary.execution.terminalRecords}</button>
      <span title="仅统计符合评估结果格式的有效输出，缺失结果不按零分计算">有效评估 <strong className="text-text-strong">{summary.evaluationOutputs.validation.valid}/{summary.counts.evaluations}</strong></span>
      {summary.evaluationOutputs.validation.invalid > 0 && <button className="text-warning hover:underline" onClick={() => focusResults("attention")}>格式无效 {summary.evaluationOutputs.validation.invalid}</button>}
      {summary.evaluationOutputs.validation.unavailable > 0 && <button className="text-warning hover:underline" onClick={() => focusResults("missing")}>结果未获得 {summary.evaluationOutputs.validation.unavailable}</button>}
    </div>
    <Card><CardHeader className="px-3 py-3" title="用例结果" description="整体与用例使用同一列指标对照；评分仅统计有效结果。积分和累计耗时包含执行与评估，展开用例可定位到单次采样。" />
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Input className="h-8 max-w-52 text-xs" aria-label="搜索用例" placeholder="搜索用例名称" value={query} onChange={(e) => setQuery(e.target.value)} />
        <NativeSelect aria-label="数据集筛选" value={dataset} onChange={(e) => setDataset(e.target.value)}><option value="">全部数据集</option>{view.datasets.map((item) => <option key={item.datasetId} value={item.datasetId}>{item.name}</option>)}</NativeSelect>
        <NativeSelect aria-label="结果筛选" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">全部结果</option><option value="attention">执行异常 / 评估异常</option><option value="running">尚未结束</option><option value="not-run">尚未运行</option><option value="missing">结果文件未获得</option><option value="unscored">未获得有效评估</option></NativeSelect>
        {fields.length > 0 && <label className="flex items-center gap-2 text-sm">评估指标 <NativeSelect aria-label="评估指标" value={selectedMetric} onChange={(e) => setMetric(e.target.value)}><option value="__all">全部指标</option>{fields.map((field) => <option key={field.jsonPointer} value={field.jsonPointer}>{metricLabel(field)}</option>)}</NativeSelect></label>}
      </div>
      {rows.length === 0 ? <EmptyState title="没有符合条件的用例" description="调整筛选条件，或在项目设置中查看测试范围。" /> : <Table aria-label="用例结果" className="w-full table-fixed" style={{ minWidth: 575 + visibleFields.length * 90 }}>
        <colgroup><col style={{ width: 200 }} /><col style={{ width: 85 }} /><col style={{ width: 90 }} />{visibleFields.map((field) => <col key={field.jsonPointer} style={{ width: 90 }} />)}<col style={{ width: 135 }} /><col style={{ width: 110 }} /></colgroup>
        <TableHeader><TableRow className="bg-surface-muted/60">
          <TableHead className="h-9 px-3 text-xs">用例 / 采样</TableHead><TableHead className="h-9 px-3 text-xs">执行完成</TableHead><TableHead className="h-9 px-3 text-xs">有效评估</TableHead>
          {visibleFields.map((field) => <TableHead key={field.jsonPointer} className="h-9 px-3 text-right text-xs" title={field.description ?? undefined}>{metricLabel(field)}</TableHead>)}
          <TableHead className="h-9 px-3 text-right text-xs">积分 / 累计耗时</TableHead><TableHead className="h-9 px-3 text-right text-xs">操作</TableHead>
        </TableRow></TableHeader>
        <TableBody><TableRow className="border-b border-border bg-surface-muted/60">
          <TableCell className={cellClass}><strong>整体结果</strong><span className="block text-[11px] text-text-muted">项目全部当前采样</span></TableCell>
          <TableCell className={cellClass}>{summary.execution.statuses.succeeded}/{summary.execution.records}</TableCell>
          <TableCell className={cellClass}>{summary.evaluationOutputs.validation.valid}/{summary.counts.evaluations}</TableCell>
          <MetricCells outputs={summary.evaluationOutputs} fields={visibleFields} />
          <TableCell className={`${cellClass} text-right`}><ResultCost summary={summary} /></TableCell>
          <TableCell className={`${cellClass} text-right`}><button className="link" onClick={() => focusResults("all")}>全部用例</button></TableCell>
        </TableRow>{rows.map((row) => {
          const sample = samples.get(row.projectSampleId)!;
          const single = row.samplingIds.length === 1;
          const open = expanded.has(row.projectSampleId);
          const activate = () => { if (single) setSampling(row.samplingIds[0]!); else setExpanded((current) => { const next = new Set(current); if (open) next.delete(row.projectSampleId); else next.add(row.projectSampleId); return next; }); };
          const groups = view.datasets.filter((item) => row.datasetIds.includes(item.datasetId)).map((item) => item.name).join("、");
          return <Fragment key={row.projectSampleId}><TableRow className="border-b border-border hover:bg-surface-hover">
            <TableCell className={cellClass}><button className="block max-w-full truncate text-left font-semibold text-text-strong hover:underline disabled:text-text-muted" title={dataTitle(sample.data)} disabled={!row.samplingIds.length} aria-expanded={single ? undefined : open} onClick={activate}>{dataTitle(sample.data)}</button><p className="mt-0.5 truncate text-[11px] text-text-muted" title={groups}>{groups}</p></TableCell>
            <TableCell className={`${cellClass} tabular-nums`}>{row.summary.execution.statuses.succeeded}/{row.summary.execution.records}
              {row.summary.execution.statuses.failed > 0 && <span className="block text-[11px] text-danger">失败 {row.summary.execution.statuses.failed}</span>}
              {row.summary.execution.statuses.cancelled > 0 && <span className="block text-[11px] text-text-muted">取消 {row.summary.execution.statuses.cancelled}</span>}
            </TableCell>
            <TableCell className={`${cellClass} tabular-nums`}>{row.summary.evaluationOutputs.validation.valid}/{row.summary.counts.evaluations}
              {row.summary.evaluation.statuses.failed > 0 && <span className="block text-[11px] text-danger">失败 {row.summary.evaluation.statuses.failed}</span>}
              {row.summary.evaluation.statuses.cancelled > 0 && <span className="block text-[11px] text-text-muted">取消 {row.summary.evaluation.statuses.cancelled}</span>}
              {row.summary.evaluationOutputs.validation.invalid > 0 && <span className="block text-[11px] text-warning">格式无效 {row.summary.evaluationOutputs.validation.invalid}</span>}
            </TableCell>
            <MetricCells outputs={row.summary.evaluationOutputs} fields={visibleFields} /><TableCell className={`${cellClass} text-right`}><ResultCost summary={row.summary} /></TableCell>
            <TableCell className={`${cellClass} text-right`}>{row.samplingIds.length ? <button className="link whitespace-nowrap font-medium" aria-expanded={single ? undefined : open} onClick={activate}>{single ? "查看结果" : `${open ? "收起" : "展开"} ${row.samplingIds.length} 次采样`}</button> : <Link className="link whitespace-nowrap" to="/projects/$projectId/runs/new" params={{ projectId }} search={{ projectSampleId: row.projectSampleId }}>运行此用例</Link>}</TableCell>
          </TableRow>{!single && open && <SamplingRows projectId={projectId} sampleId={row.projectSampleId} fields={visibleFields} running={!!view.currentRun} onOpen={setSampling} />}</Fragment>;
        })}</TableBody>
      </Table>}

    </Card>
    {sampling && <Dialog open compact placement="right" title="采样结果" description="查看本次评估结论与产物；关闭后继续比较用例。" onClose={() => setSampling(null)}
      footer={<><Link className="link text-sm" to="/projects/$projectId/samplings/$samplingId" params={{ projectId, samplingId: sampling }}>独立打开</Link><Button onClick={() => setSampling(null)}>返回用例列表</Button></>}><Suspense fallback={<LoadingBlock />}><SamplingResult key={sampling} projectId={projectId} samplingId={sampling} /></Suspense></Dialog>}
  </>;
}
