import type { EvaluationOutputSummary, MetricSummary, OutputFieldSummary } from "@/api-sdk/types";
import type { ReactNode } from "react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@springbrand/site-block";
import { Bot, ChevronDown, Scale } from "lucide-react";
import { MetricCard } from "@/components/ui/data-display";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/badge";
import { formatCompact, formatDuration, formatNumber, formatPercent, formatStatistic, standardDeviation } from "@/lib/format";
import { AgentMetricPair, MetricValue } from "./metric-value";
import { ResourceMetrics } from "./resource-metrics";
import { ModelName } from "./token-metrics";

function fieldValue(field: OutputFieldSummary, compact = false): string {
  const values: string[] = [];
  const distribution = field.distribution ?? [];
  if (field.numeric) values.push(compact
    ? `均值 ${formatStatistic(field.numeric.mean)} · N=${field.numeric.count}`
    : `均值 ${formatStatistic(field.numeric.mean)} · 标准差 ${formatStatistic(standardDeviation(field.numeric.variance))} · 中位数 ${formatStatistic(field.numeric.median)} · 最小 ${formatStatistic(field.numeric.min)} · 最大 ${formatStatistic(field.numeric.max)}`);
  values.push(...distribution.map((item) => `${JSON.stringify(item.value)}: ${item.count} (${formatPercent(item.share)})`));
  if (field.nullCount !== undefined) values.push(`null: ${field.nullCount}`);
  return values.join(" · ") || "暂无有效观察";
}

/** Compact projection of every field supplied by the same server-side presentation plan. */
export function OutputPreview({ outputs }: { outputs: EvaluationOutputSummary }) {
  return <div className="flex min-w-40 max-w-sm flex-col gap-1.5 whitespace-normal py-1 text-xs">{outputs.fields.length === 0 ? "暂无可统计字段" : outputs.fields.map((field) => (
    <span key={field.jsonPointer}><strong className="font-medium text-text-strong">{field.title}</strong>：{fieldValue(field, true)}
      {field.missingEvaluationCount > 0 && <span className="ml-1 text-warning">缺失 {field.missingEvaluationCount}</span>}</span>
  ))}</div>;
}

export function OutputFields({ outputs, compact = false }: { outputs: EvaluationOutputSummary; compact?: boolean }) {
  return <Card>
    <CardHeader className={compact ? "px-3 py-2" : undefined} title="评估指标统计" description={`有效 ${outputs.validation.valid} · 无效 ${outputs.validation.invalid} · 未获得 ${outputs.validation.unavailable}`} />
    <CardBody className={compact ? "grid grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] gap-2 p-3" : "grid grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-4"}>
      {outputs.fields.length === 0 && <p className="text-sm text-text-muted">暂无可统计字段。原始结果可在采样详情查看。</p>}
      {outputs.fields.map((field) => <section key={field.jsonPointer} className={compact ? "min-w-0 rounded-md border border-border p-3" : "min-w-0 rounded-lg border border-border p-4"}>
        <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">{field.title}</h3>{field.coverage !== "complete" && <StatusBadge status={field.coverage} />}</div>
        <p className="mt-1 text-xs text-text-muted">{field.description}</p>
        {field.numeric ? <>
          <p className="mt-4 flex flex-wrap items-baseline gap-2 text-2xl font-semibold tabular text-text-strong">{formatStatistic(field.numeric.mean)}<span className="text-xs font-normal text-text-muted">均值 · N = {field.numeric.count}</span></p>
          <details open={compact || undefined} className="mt-3 text-xs text-text-muted">
            <summary className="cursor-pointer">分布与字段信息</summary>
            <p className="mt-2 leading-6">{fieldValue(field)}</p>
            <p className="mt-1 break-all font-mono">{field.jsonPointer || "$"} · {field.kinds.join(" / ")}</p>
          </details>
        </> : <>
          <p className="mt-4 text-sm leading-6 font-medium tabular text-text-strong">{fieldValue(field)}</p>
          <p className="mt-2 break-all font-mono text-xs text-text-muted">{field.jsonPointer || "$"} · {field.kinds.join(" / ")}</p>
        </>}
        <p className="mt-2 text-xs text-text-muted">{field.contributingEvaluationCount} 份评估 · {field.observationCount} 个观察值 · 缺失 {field.missingEvaluationCount} 份</p>
        {field.diagnostics.length > 0 && <p className="mt-1 text-xs text-text-muted">{field.diagnostics.map((item) => `${MISSING[item.reason]} ${item.evaluations}`).join(" · ")}</p>}
      </section>)}
    </CardBody>
  </Card>;
}

const MISSING = { "not-succeeded": "评估未成功", "invalid-output": "结果无效", "unavailable-output": "结果未获得", absent: "字段缺失" };

export function SummaryCards({ summary, children }: { summary: MetricSummary; children?: ReactNode }) {
  const execution = summary.execution;
  const evaluation = summary.evaluation;
  const running = execution.records - execution.terminalRecords;
  return <div className="flex flex-col gap-6">
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      <MetricCard label="采样" value={formatNumber(summary.counts.samplings)} hint={`${summary.counts.projectSamples} 条样本 · ${summary.counts.evaluations} 个评估`} />
      <MetricCard label="执行成功率" value={formatPercent(execution.successRate)} tone={execution.statuses.failed > 0 ? "warning" : undefined}
        hint={`成功 ${execution.statuses.succeeded} · 失败 ${execution.statuses.failed} · 未结束 ${running}`} />
      <MetricCard label="评估成功率" value={formatPercent(evaluation.successRate)} tone={evaluation.statuses.failed > 0 ? "warning" : undefined}
        hint={`成功 ${evaluation.statuses.succeeded} · 失败 ${evaluation.statuses.failed}`} />
      <MetricCard label="积分消耗" value={<AgentMetricPair execution={summary.executionAgent.costs.chargedUnits} evaluation={summary.evaluationAgents.costs.chargedUnits} />} />
      <MetricCard label="Token" value={<AgentMetricPair execution={summary.executionAgent.tokens.total} evaluation={summary.evaluationAgents.tokens.total} format={formatCompact} />} />
    </div>
    <OutputFields outputs={summary.evaluationOutputs} />
    {children}
    <details className="group rounded-[var(--radius-card)] border border-border bg-surface">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-[var(--radius-card)] px-5 py-4 hover:bg-surface-hover [&::-webkit-details-marker]:hidden">
        <span><span className="block text-sm font-semibold text-text-strong">资源与轨迹统计</span>
          <span className="mt-1 block text-[13px] text-text-muted">先看消耗摘要，再分别展开执行与评估 Agent，按费用、Token、操作次数和耗时查看明细。</span></span>
        <ChevronDown className="size-4 shrink-0 text-text-muted transition-transform group-open:rotate-180" />
      </summary>
    <Accordion multiple className="border-t border-border">
      {([
        ["执行 Agent", summary.executionAgent, execution, Bot],
        ["评估 Agent", summary.evaluationAgents, evaluation, Scale],
      ] as const).map(([title, statistics, stage, Icon]) => <AccordionItem key={title} value={title}>
        <AccordionTrigger className="items-center rounded-none px-5 py-5 hover:bg-surface-hover hover:no-underline">
          <span className="grid min-w-0 flex-1 gap-4 lg:grid-cols-[minmax(190px,1fr)_2fr] lg:items-center">
            <span className="flex items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-muted"><Icon className="size-4 text-text-secondary" /></span>
              <span><span className="block font-semibold text-text-strong">{title} 资源与轨迹</span>
                <span className="mt-1 block text-xs font-normal text-text-muted">{stage.records} 个 Agent · 已结束 {stage.terminalRecords}</span>
                <span className="mt-1 block max-w-56 break-words text-xs font-normal text-text-muted">模型 <ModelName statistics={statistics} /></span>
                <span className="mt-2 flex flex-wrap items-center gap-2 text-xs font-normal text-text-muted">资源完整性 <StatusBadge status={statistics.coverage} /></span></span>
            </span>
            <span className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <span><span className="block text-xs font-normal text-text-muted">Token</span><span className="mt-1 block font-semibold tabular-nums"><MetricValue metric={statistics.tokens.total} format={formatCompact} /></span></span>
              <span><span className="block text-xs font-normal text-text-muted">实际积分</span><span className="mt-1 block font-semibold tabular-nums"><MetricValue metric={statistics.costs.chargedUnits} format={formatStatistic} /></span></span>
              <span><span className="block text-xs font-normal text-text-muted">缓存命中率</span><span className="mt-1 block font-semibold tabular-nums"><MetricValue metric={statistics.cacheHitRate} format={formatPercent} /></span></span>
              <span><span className="block text-xs font-normal text-text-muted">平均 Agent 耗时</span><span className="mt-1 block font-semibold tabular-nums">{stage.agentDurationMs?.mean === null || stage.agentDurationMs?.mean === undefined ? "未获得" : formatDuration(stage.agentDurationMs.mean)}</span></span>
            </span>
          </span>
        </AccordionTrigger>
        <AccordionContent keepMounted className="h-auto px-5 pb-6">
          <ResourceMetrics statistics={statistics} distribution={statistics.distribution} durations={stage} showCoverage={false} />
        </AccordionContent>
      </AccordionItem>)}
    </Accordion>
    </details>
  </div>;
}
