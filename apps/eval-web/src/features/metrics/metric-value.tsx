import type { MetricNumber } from "@/api-sdk/types";
import { StatusBadge } from "@/components/ui/badge";
import { formatNumber } from "@/lib/format";

/** A measured value always travels with its source coverage, including a known zero. */
export function MetricValue({ metric, format = formatNumber }: { metric: MetricNumber; format?: (value: number) => string }) {
  return <span className="inline-flex flex-wrap items-center gap-1.5">
    <span className="tabular-nums">{metric.value === null ? "未获得" : format(metric.value)}</span>
    <StatusBadge status={metric.coverage} />
  </span>;
}

export function AgentMetricPair({ execution, evaluation, format }: {
  execution: MetricNumber; evaluation: MetricNumber; format?: (value: number) => string;
}) {
  return <span className="inline-flex flex-col gap-1 text-sm">
    <span>执行 <MetricValue metric={execution} format={format} /></span>
    <span>评估 <MetricValue metric={evaluation} format={format} /></span>
  </span>;
}
