import { ChevronDown, X } from "lucide-react";
import type { ReactNode } from "react";
import type { ComparisonProject, ComparisonProjectValues, NumericSummary, OutputFieldSummary } from "@/api-sdk/types";
import { Card } from "@/components/ui/card";
import type { ComparisonViewMode } from "@/features/metrics/comparison-view";
import { comparisonExecutionMetrics, ExecutionMetrics, ExecutionMetricValue } from "@/features/metrics/execution-metrics";
import { formatDuration, formatNumber, formatPercent, formatStatistic } from "@/lib/format";

const scalarLabel = (value: string | number | boolean) => value === true ? "是" : value === false ? "否" : String(value);

export function ComparisonScore({ score, compact = false }: { score: OutputFieldSummary | null; compact?: boolean }) {
  if (!score) return <span className="text-xs text-text-muted">无有效评分</span>;
  return <div className="min-w-0 space-y-1.5">
    {score.numeric && score.numeric.count > 0 && <div className="flex flex-wrap items-baseline gap-x-2">
      <span className={compact ? "font-semibold tabular-nums text-text-strong" : "text-3xl font-semibold tracking-tight tabular-nums text-text-strong"}>{formatStatistic(score.numeric.mean)}</span>
      {!compact && <span className="text-xs text-text-muted">均值</span>}
    </div>}
    {score.distribution.length > 0 && <dl aria-label="评分分布" className={compact ? "space-y-1 text-xs" : "space-y-1.5"}>
      {score.distribution.map((entry) => <div key={`${typeof entry.value}:${entry.value}`}
        className={compact ? "flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5" : "flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-md bg-surface-muted/50 px-2.5 py-2"}>
        <dt className="min-w-0 break-words text-xs font-medium text-text-secondary">{scalarLabel(entry.value)}</dt>
        <dd className="shrink-0 tabular-nums"> <span className={compact ? "font-semibold text-text-strong" : "text-base font-semibold tracking-tight text-text-strong"}>{formatPercent(entry.share)}</span><span className="text-[11px] text-text-muted"> · {formatNumber(entry.count)} 次</span></dd>
      </div>)}
    </dl>}
    <p className="text-[11px] tabular-nums text-text-muted">有效评分 N = {formatNumber(score.contributingEvaluationCount)}{score.numeric && score.numeric.count !== score.contributingEvaluationCount && ` · 数值 n = ${formatNumber(score.numeric.count)}`}</p>
  </div>;
}

function Distribution({ value, format = formatStatistic }: { value: NumericSummary; format?: (value: number) => string }) {
  const show = (number: number | null) => number === null ? "未获得" : format(number);
  return <span className="tabular-nums">均值 {show(value.mean)} · 中位数 {show(value.median)}<br />范围 {show(value.min)}–{show(value.max)}<br />已获得 {formatNumber(value.count)} · 未获得 {formatNumber(value.missing)}</span>;
}

export function ComparisonSummary({ projects, values, title, scope, onRemove, viewMode = "evaluation" }: {
  projects: readonly ComparisonProject[]; values: readonly ComparisonProjectValues[]; title: string; scope: ReactNode;
  onRemove: (projectId: string) => void; viewMode?: ComparisonViewMode;
}) {
  return <Card aria-label="当前范围表现" className="min-w-0">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-4">
      <div><h2 className="text-sm font-semibold text-text-strong">{title}</h2><p className="mt-1 text-xs text-text-muted">{scope}</p></div>
      <div className="flex items-baseline gap-2"><strong className="text-2xl font-semibold tracking-tight tabular-nums text-text-strong">{formatNumber(values[0]?.dataCount ?? 0)}</strong><span className="text-xs text-text-muted">条共同已评数据</span></div>
    </div>
    <div className="overflow-x-auto overscroll-x-contain" tabIndex={0} aria-label="项目表现并排概览">
      <div className="grid divide-x divide-border" style={{ gridTemplateColumns: `repeat(${projects.length}, minmax(230px, 1fr))` }}>
        {projects.map((meta) => {
          const value = values.find((item) => item.projectId === meta.project.projectId);
          return <section key={meta.project.projectId} aria-label={`${meta.project.name} 表现`} className="min-w-0 px-4 py-4">
            <div className="flex items-start justify-between gap-2"><h3 className="min-w-0 break-words text-sm font-semibold text-text-strong">{meta.project.name}</h3>
              <button type="button" aria-label={`移除 ${meta.project.name}`} onClick={() => onRemove(meta.project.projectId)} className="shrink-0 rounded p-0.5 text-text-faint hover:bg-surface-muted hover:text-text-strong"><X className="size-3.5" /></button>
            </div>
            <p className="mt-2 break-words text-xs text-text-secondary">执行 Agent · {meta.executionAgentName}</p>
            <p className="mt-1 break-words text-[11px] text-text-muted">{meta.framework.toUpperCase()} · {meta.executionModel ?? "模型未提供"}</p>
            <p className="mt-1.5 break-words text-[11px] text-text-muted">评估 Agent · {meta.evaluationAgentName ?? "未提供"}</p>
            {value && <>
              <div className="my-5 min-h-16">{viewMode === "execution"
                ? <ExecutionMetrics value={comparisonExecutionMetrics(value.resources)} average />
                : <ComparisonScore score={value.score} />}</div>
              <p className="mt-1 text-[11px] tabular-nums text-text-muted">有效采样 {formatNumber(value.samplingCount)} · 有效评估 {formatNumber(value.evaluationCount)}</p>
              {viewMode === "execution" && <details className="group mt-4 border-t border-border pt-3 text-xs text-text-muted">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-2 hover:text-text-strong [&::-webkit-details-marker]:hidden">执行消耗明细<ChevronDown className="size-3.5 transition-transform group-open:rotate-180" /></summary>
                <dl className="mt-3 space-y-3 leading-5">
                  <div><dt className="text-text-secondary">累计实际积分</dt><dd><ExecutionMetricValue metric={value.resources.chargedUnits} /></dd></div>
                  <div><dt className="text-text-secondary">单 Agent 积分分布{value.resources.chargedUnitsPerAgent.coverage === "partial" && " · 部分"}</dt><dd><Distribution value={value.resources.chargedUnitsPerAgent} /></dd></div>
                  <div><dt className="text-text-secondary">Agent 耗时分布</dt><dd><Distribution value={value.resources.agentDurationMs} format={formatDuration} /></dd></div>
                  <div><dt>累计 Agent 耗时</dt><dd className="text-text-secondary">{value.resources.agentDurationMs.total === null ? "未获得" : formatDuration(value.resources.agentDurationMs.total)}</dd></div>
                </dl>
                <p className="mt-3 border-t border-border pt-2 text-[11px] leading-5">仅当前范围的执行 Agent，不含评估 Agent。耗时不是并行运行的墙钟时间；缺报不按 0 计算。</p>
              </details>}
            </>}
          </section>;
        })}
      </div>
    </div>
  </Card>;
}
