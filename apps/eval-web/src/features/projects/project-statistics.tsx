import type { MetricSummary } from "@/api-sdk/types";
import { OutputFields } from "@/features/metrics/summary";
import { ResourceMetrics } from "@/features/metrics/resource-metrics";

/** Project statistics stay beside the results they describe, using the same server projection. */
export function ProjectStatistics({ summary }: { summary: MetricSummary }) {
  return <section aria-label="项目完整统计" className="flex min-w-0 flex-col gap-4">
    <OutputFields outputs={summary.evaluationOutputs} compact />
    <section aria-label="资源统计" className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-sm font-semibold">资源消耗与调用统计</h2><p className="text-xs text-text-muted">项目当前结果 · 执行与评估分别统计 · 缺失不补零</p></div>
      <div className="grid min-w-0 items-start gap-3 grid-cols-[repeat(auto-fit,minmax(min(100%,650px),1fr))]">
        {([
          ["执行 Agent", summary.executionAgent, summary.execution],
          ["评估 Agent", summary.evaluationAgents, summary.evaluation],
        ] as const).map(([title, statistics, stage]) => <section aria-label={`${title}完整资源统计`} key={title} className="min-w-0 rounded-lg border border-border bg-surface">
          <div className="border-b border-border px-3 py-2">
            <h3 className="text-sm font-semibold">{title}</h3>
            <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-muted">
              <span>共 {stage.records} 个</span><span>成功 {stage.statuses.succeeded}</span><span>失败 {stage.statuses.failed}</span><span>取消 {stage.statuses.cancelled}</span><span>未结束 {stage.records - stage.terminalRecords}</span><span>尝试 {stage.attempts} 次</span><span>重启 {stage.restarts} 次</span>
            </p>
          </div>
          <div className="min-w-0 p-3"><ResourceMetrics report statistics={statistics} distribution={statistics.distribution} durations={stage} /></div>
        </section>)}
      </div>
    </section>
  </section>;
}
