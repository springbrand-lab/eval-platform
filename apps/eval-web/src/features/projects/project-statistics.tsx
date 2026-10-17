import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@springbrand/site-block";
import type { MetricSummary, ResourceStatistics, StageStatistics } from "@/api-sdk/types";
import { ResourceMetrics } from "@/features/metrics/resource-metrics";
import { MetricValue } from "@/features/metrics/metric-value";
import { ModelName } from "@/features/metrics/token-metrics";
import { formatBytes, formatDuration, formatPercent, formatStatistic } from "@/lib/format";

function StageStat({ label, value, tone = "neutral" }: { label: string; value: number; tone?: "neutral" | "success" | "danger" | "warning" }) {
  const toneClass = {
    neutral: "border-border bg-surface-muted/60 text-text-secondary",
    success: "border-success/20 bg-success-soft text-success",
    danger: "border-danger/20 bg-danger-soft text-danger",
    warning: "border-warning/20 bg-warning-soft text-warning",
  }[tone];
  return <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${toneClass}`}>
    <span>{label}</span><strong className="font-semibold tabular-nums">{value}</strong>
  </span>;
}

function OverviewMetric({ label, title, children }: { label: string; title?: string; children: React.ReactNode }) {
  return <div className="rounded-lg border border-border bg-surface-muted/50 px-3 py-2.5" title={title}>
    <div className="text-xs text-text-muted">{label}</div>
    <div className="mt-1 text-base font-semibold tabular-nums text-text-strong">{children}</div>
  </div>;
}

function AgentOverview({ title, statistics, stage }: { title: string; statistics: ResourceStatistics; stage: StageStatistics }) {
  const bytes = (value: number | null | undefined) => value === null || value === undefined ? "未获得" : value < 1024 ? `${formatStatistic(value)} B` : formatBytes(value);
  const duration = (value: number | null | undefined) => value === null || value === undefined ? "未获得" : formatDuration(value);
  return <section aria-label={`${title}总览`} className="space-y-4 rounded-lg border border-border bg-surface-muted/20 p-3">
    <div><h4 className="text-sm font-semibold text-text-strong">总览</h4><p className="mt-1 text-xs text-text-muted">模型 <ModelName statistics={statistics} /> · 先看资源消耗和工具使用，再进入下方分项明细。</p></div>
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
      <OverviewMetric label="实际积分"><MetricValue metric={statistics.costs.chargedUnits} format={formatStatistic} /></OverviewMetric>
      <OverviewMetric label="总 Token"><MetricValue metric={statistics.tokens.total} /></OverviewMetric>
      <OverviewMetric label="缓存命中率" title="缓存读取 ÷（输入 Token + 缓存读取 Token）"><MetricValue metric={statistics.cacheHitRate} format={formatPercent} /></OverviewMetric>
      <OverviewMetric label="平均 Agent 耗时">{duration(stage.agentDurationMs?.mean)}</OverviewMetric>
      <OverviewMetric label="模型请求"><MetricValue metric={statistics.modelRequests.count} /></OverviewMetric>
    </div>
    <section aria-label={`${title}工具调用概况`} className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="border-b border-border px-3 py-2.5"><h5 className="text-sm font-semibold text-text-strong">工具调用概况</h5><p className="mt-1 text-xs text-text-muted">每个工具一行；长度是单次调用的平均值。</p></div>
      <div className="overflow-x-auto">
        <Table aria-label="工具调用概况" className="min-w-[760px] text-[13px]">
          <TableCaption className="m-0 border-t border-border px-3 py-2 text-left text-xs">未获得的长度或耗时不按零计数。</TableCaption>
          <TableHeader className="bg-surface-muted/60"><TableRow>
            {['工具', '调用次数', '成功', '失败', '平均耗时', '平均调用长度', '平均返回长度'].map((label, index) => <TableHead key={label} className={index === 0 ? 'px-3 text-xs' : 'text-right text-xs'}>{label}</TableHead>)}
          </TableRow></TableHeader>
          <TableBody>{statistics.trajectory.byTool.length === 0 ? <TableRow><TableCell colSpan={7} className="px-3 py-5 text-center text-text-muted">暂无工具调用</TableCell></TableRow> : statistics.trajectory.byTool.map((tool) => <TableRow key={tool.toolName ?? 'unknown'}>
            <TableHead scope="row" className="px-3 font-medium text-text-strong">{tool.toolName ?? '未识别工具'}</TableHead>
            <TableCell className="text-right font-semibold tabular-nums"><MetricValue metric={tool.count} /></TableCell>
            <TableCell className="text-right tabular-nums">{tool.completed}</TableCell>
            <TableCell className={`text-right tabular-nums ${tool.failed > 0 ? 'font-medium text-danger' : 'text-text-muted'}`}>{tool.failed}</TableCell>
            <TableCell className="text-right tabular-nums">{duration(tool.durationMs?.mean)}</TableCell>
            <TableCell className="text-right tabular-nums">{bytes(tool.inputLength?.mean)}</TableCell>
            <TableCell className="pr-3 text-right tabular-nums">{bytes(tool.outputLength?.mean)}</TableCell>
          </TableRow>)}</TableBody>
        </Table>
      </div>
    </section>
  </section>;
}

/** Project statistics stay beside the results they describe, using the same server projection. */
export function ProjectStatistics({ summary }: { summary: MetricSummary }) {
  return <section aria-label="项目完整统计" className="flex min-w-0 flex-col gap-4">
    <section aria-label="资源统计" className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-sm font-semibold">资源消耗与调用统计</h2><p className="text-xs text-text-muted">项目当前结果 · 执行与评估分别统计 · 缺失不补零</p></div>
      <div className="grid min-w-0 items-start gap-3 grid-cols-[repeat(auto-fit,minmax(min(100%,650px),1fr))]">
        {([
          ["执行 Agent", summary.executionAgent, summary.execution],
          ["评估 Agent", summary.evaluationAgents, summary.evaluation],
        ] as const).map(([title, statistics, stage]) => <section aria-label={`${title}完整资源统计`} key={title} className="min-w-0 rounded-lg border border-border bg-surface">
          <div className="border-b border-border px-3 py-3">
            <h3 className="text-sm font-semibold">{title}</h3>
            <div className="mt-2 flex flex-wrap gap-1.5" aria-label={`${title}状态摘要`}>
              <StageStat label="总数" value={stage.records} />
              <StageStat label="成功" value={stage.statuses.succeeded} tone="success" />
              <StageStat label="失败" value={stage.statuses.failed} tone={stage.statuses.failed > 0 ? "danger" : "neutral"} />
              <StageStat label="取消" value={stage.statuses.cancelled} />
              <StageStat label="未结束" value={stage.records - stage.terminalRecords} tone={stage.records - stage.terminalRecords > 0 ? "warning" : "neutral"} />
              <StageStat label="尝试" value={stage.attempts} />
              <StageStat label="重启" value={stage.restarts} />
            </div>
          </div>
          <div className="min-w-0 space-y-4 p-3">
            <AgentOverview title={title} statistics={statistics} stage={stage} />
            <ResourceMetrics compact statistics={statistics} distribution={statistics.distribution} durations={stage} />
          </div>
        </section>)}
      </div>
    </section>
  </section>;
}
