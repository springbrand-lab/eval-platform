import type { MetricNumber } from "@/api-sdk/types";
import { formatNumber } from "@/lib/format";

/** Coverage is shown at the resource boundary; missing measurements still differ from zero. */
export function MetricValue({ metric, format = formatNumber }: { metric: MetricNumber; format?: (value: number) => string }) {
  return <span className="tabular-nums">{metric.value === null ? "未获得" : format(metric.value)}</span>;
}

export function AgentMetricPair({ execution, evaluation, format }: {
  execution: MetricNumber; evaluation: MetricNumber; format?: (value: number) => string;
}) {
  return <span className="inline-flex flex-col gap-1 text-sm">
    <span>执行 <MetricValue metric={execution} format={format} /></span>
    <span>评估 <MetricValue metric={evaluation} format={format} /></span>
  </span>;
}
