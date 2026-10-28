import type { ComparisonResources, MetricNumber } from "@/api-sdk/types";
import { cn } from "@/lib/cn";
import { formatDuration, formatPercent, formatStatistic } from "@/lib/format";
import { MetricValue } from "./metric-value";

interface ExecutionMetricValues {
  readonly chargedUnits: MetricNumber;
  readonly durationMs: number | null;
  readonly durationPartial?: boolean;
  readonly cacheHitRate: MetricNumber;
  readonly toolSuccessRate: MetricNumber;
}

export function comparisonExecutionMetrics(resources: ComparisonResources): ExecutionMetricValues {
  return {
    chargedUnits: { value: resources.chargedUnitsPerAgent.mean, coverage: resources.chargedUnitsPerAgent.coverage },
    durationMs: resources.agentDurationMs.mean,
    durationPartial: resources.agentDurationMs.count > 0 && resources.agentDurationMs.missing > 0,
    cacheHitRate: resources.cacheHitRate,
    toolSuccessRate: resources.toolSuccessRate,
  };
}

export function ExecutionMetricValue({ metric, format = formatStatistic, rate = false }: {
  metric: MetricNumber; format?: (value: number) => string; rate?: boolean;
}) {
  const inapplicable = rate && metric.value === null && metric.coverage === "complete";
  return <span className="tabular-nums" title={inapplicable ? "当前范围没有可计算此比率的观察" : undefined}>
    {inapplicable ? "—" : <MetricValue metric={metric} format={format} />}
    {metric.value !== null && metric.coverage !== "complete" && " · 部分"}
  </span>;
}

export function ExecutionMetrics({ value, average = false, compact = false }: {
  value: ExecutionMetricValues; average?: boolean; compact?: boolean;
}) {
  const metrics = [
    { label: average ? "平均执行积分" : "实际执行积分", value: <ExecutionMetricValue metric={value.chargedUnits} /> },
    { label: average ? "平均执行耗时" : "实际执行耗时", value: <span className="tabular-nums">{value.durationMs === null ? "未获得" : formatDuration(value.durationMs)}{value.durationMs !== null && value.durationPartial && " · 部分"}</span> },
    { label: "缓存命中率", value: <ExecutionMetricValue metric={value.cacheHitRate} format={formatPercent} rate /> },
    { label: "工具调用成功率", value: <ExecutionMetricValue metric={value.toolSuccessRate} format={formatPercent} rate /> },
  ];
  return <dl aria-label="执行 Agent 指标" className={cn("grid min-w-0 grid-cols-2", compact ? "gap-x-3 gap-y-1.5 text-[11px]" : "gap-3 text-xs")}>
    {metrics.map((metric) => <div key={metric.label} className="min-w-0">
      <dt className={cn("text-text-muted", compact && "text-[10px] leading-4")}>{metric.label}</dt>
      <dd className={cn("break-words font-semibold text-text-strong", compact ? "mt-0.5" : "mt-1.5 text-lg tracking-tight")}>{metric.value}</dd>
    </div>)}
  </dl>;
}
