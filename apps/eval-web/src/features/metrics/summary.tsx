import type { EvaluationOutputSummary, MetricSummary, OutputFieldSummary } from "@/api-sdk/types";
import type { ReactNode } from "react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@springbrand/site-block";
import { AlertCircle, Bot, CheckCircle2, ChevronDown, CircleHelp, Scale } from "lucide-react";
import { MetricCard } from "@/components/ui/data-display";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/badge";
import { formatCompact, formatDuration, formatNumber, formatPercent, formatStatistic, standardDeviation } from "@/lib/format";
import { AgentMetricPair, MetricValue } from "./metric-value";
import { ResourceMetrics, stageStatusFor } from "./resource-metrics";
import { ModelName } from "./token-metrics";
import { stageInProgressCount } from "@/features/runs/run-status";

function fieldValue(field: OutputFieldSummary, compact = false): string {
  const values: string[] = [];
  const distribution = field.distribution ?? [];
  if (field.numeric) values.push(compact
    ? `均值 ${formatStatistic(field.numeric.mean)} · N=${field.numeric.count}`
    : `均值 ${formatStatistic(field.numeric.mean)} · 标准差 ${formatStatistic(standardDeviation(field.numeric.variance))} · 中位数 ${formatStatistic(field.numeric.median)} · 最小 ${formatStatistic(field.numeric.min)} · 最大 ${formatStatistic(field.numeric.max)}`);
  values.push(...distribution.map((item) => `${outputValue(item.value)}: ${item.count} (${formatPercent(item.share)})`));
  if (field.nullCount !== undefined) values.push(`null: ${field.nullCount}`);
  return values.join(" · ") || "暂无有效观察";
}

function outputValue(value: unknown): string {
  if (value === true) return "是";
  if (value === false) return "否";
  if (value === null) return "空值";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function dominantValue(field: OutputFieldSummary) {
  return (field.distribution ?? [])
    .filter((item) => item.count > 0)
    .reduce<(typeof field.distribution)[number] | undefined>((current, item) => !current || item.count > current.count ? item : current, undefined);
}

function FieldHeadline({ field }: { field: OutputFieldSummary }) {
  if (field.numeric?.count) {
    return <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="text-3xl font-semibold tracking-tight tabular-nums text-text-strong">{formatStatistic(field.numeric.mean)}</span>
      <span className="text-xs text-text-muted">平均值</span>
    </div>;
  }
  const dominant = dominantValue(field);
  if (dominant) return <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
    <span className="text-2xl font-semibold tracking-tight text-text-strong">{outputValue(dominant.value)}</span>
    <span className={`text-sm font-medium tabular-nums ${dominant.value === true ? "text-success" : dominant.value === false ? "text-danger" : "text-text-secondary"}`}>{dominant.evaluations}/{field.contributingEvaluationCount} 份{dominant.share !== null && ` · ${formatPercent(dominant.share)}`}</span>
  </div>;
  if (field.nullCount) return <div className="text-2xl font-semibold tracking-tight text-text-muted">空值</div>;
  return <div className="text-2xl font-semibold tracking-tight text-text-muted">暂无结果</div>;
}

function ValidationOverview({ outputs }: { outputs: EvaluationOutputSummary }) {
  const total = outputs.evaluations;
  const validRate = total > 0 ? outputs.validation.valid / total : null;
  const items = [
    { label: "有效结果", count: outputs.validation.valid, detail: validRate === null ? "暂无评估" : `${formatPercent(validRate)} · 共 ${total} 份`, tone: "success", icon: CheckCircle2 },
    { label: "结果无效", count: outputs.validation.invalid, detail: "不计入指标", tone: "warning", icon: AlertCircle },
    { label: "结果未获得", count: outputs.validation.unavailable, detail: "等待或缺少结果", tone: "neutral", icon: CircleHelp },
  ] as const;
  return <div aria-label="评估结果概览" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-surface-muted/30 px-3 py-2.5">
    {items.map(({ label, count, detail, tone, icon: Icon }) => <span key={label} className="inline-flex items-center gap-1.5 text-xs text-text-muted">
      <Icon className={`size-3.5 ${tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : "text-text-muted"}`} aria-hidden="true" />
      <span>{label}</span>
      <strong className="font-semibold tabular-nums text-text-strong">{count}</strong>
      <span className="text-[11px] text-text-faint">{detail}</span>
    </span>)}
  </div>;
}

/** Compact projection of every field supplied by the same server-side presentation plan. */
export function OutputPreview({ outputs }: { outputs: EvaluationOutputSummary }) {
  return <div className="flex min-w-40 max-w-sm flex-col gap-1.5 whitespace-normal py-1 text-xs">{outputs.fields.length === 0 ? "暂无可统计字段" : outputs.fields.map((field) => (
    <span key={field.jsonPointer}><strong className="font-medium text-text-strong">{field.title}</strong>：{fieldValue(field, true)}</span>
  ))}</div>;
}

function OutputFieldCard({ field, compact }: { field: OutputFieldSummary; compact: boolean }) {
  return <section className={`flex h-full min-w-0 flex-col rounded-xl border border-border ${compact ? "p-3" : "p-4"} ${field.coverage === "complete" ? "bg-surface" : "bg-surface-muted/40"}`}>
    <div className="flex min-h-[4.5rem] items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <h4 className="truncate text-sm font-semibold text-text-strong" title={field.title}>{field.title}</h4>
        <p className="mt-1 min-h-10 line-clamp-2 text-xs leading-5 text-text-muted">{field.description || "\u00a0"}</p>
      </div>
      {field.coverage !== "complete" && <StatusBadge status={field.coverage} />}
    </div>
    <div className="mt-2 flex min-h-10 items-center"><FieldHeadline field={field} /></div>
    <details className="group mt-auto w-full border-t border-border pt-3 text-xs text-text-muted">
      <summary className="flex min-h-7 cursor-pointer list-none items-center justify-between gap-2 font-medium hover:text-text-strong [&::-webkit-details-marker]:hidden"><span>查看统计详情</span><ChevronDown className="size-3.5 transition-transform group-open:rotate-180" /></summary>
      <div className="mt-3 grid gap-2 rounded-lg bg-surface-muted/60 p-3">
        <div className="grid gap-1 border-b border-border/70 pb-2 sm:grid-cols-[max-content_minmax(0,1fr)] sm:items-start sm:gap-x-4"><span className="text-text-faint">统计摘要</span><span className="min-w-0 break-words leading-5 text-text-secondary sm:text-right">{fieldValue(field)}</span></div>
        <div className="grid gap-1 border-b border-border/70 pb-2 sm:grid-cols-[max-content_minmax(0,1fr)] sm:items-start sm:gap-x-4"><span className="text-text-faint">字段路径</span><code className="min-w-0 break-all font-mono text-[11px] text-text-secondary sm:text-right">{field.jsonPointer || "$"}</code></div>
        <div className="grid gap-1 sm:grid-cols-[max-content_minmax(0,1fr)] sm:items-start sm:gap-x-4"><span className="text-text-faint">数据类型</span><span className="text-text-secondary sm:text-right">{field.kinds.join(" / ")}</span></div>
        {field.diagnostics.length > 0 && <div className="grid gap-1 border-t border-border/70 pt-2 sm:grid-cols-[max-content_minmax(0,1fr)] sm:items-start sm:gap-x-4"><span className="text-text-faint">数据说明</span><span className="break-words text-warning sm:text-right">{field.diagnostics.map((item) => `${MISSING[item.reason]} ${item.evaluations}`).join(" · ")}</span></div>}
      </div>
    </details>
  </section>;
}

export function OutputFields({ outputs, compact = false }: { outputs: EvaluationOutputSummary; compact?: boolean }) {
  return <Card>
    <CardHeader className={compact ? "px-3 py-3" : undefined} title="评估指标概览" description="先看关键结论，再查看指标分布与统计口径。" />
    <CardBody className={compact ? "p-3" : "p-5"}>
      <ValidationOverview outputs={outputs} />
      {outputs.fields.length === 0 ? <p className="mt-5 text-sm text-text-muted">暂无可统计字段。原始结果可在采样详情查看。</p> : <section className="mt-6" aria-label="评估结果">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-text-strong">评估结果</h3>
          <span className="text-xs text-text-muted">共 {outputs.fields.length} 项 · 以有效评估结果计算</span>
        </div>
        <div className={compact ? "grid grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] gap-2" : "grid grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-4"}>
          {outputs.fields.map((field) => <OutputFieldCard key={field.jsonPointer} field={field} compact={compact} />)}
        </div>
      </section>}
    </CardBody>
  </Card>;
}

const MISSING = { "not-succeeded": "评估未成功", "invalid-output": "结果无效", "unavailable-output": "结果未获得", absent: "字段缺失" };

export function SummaryCards({ summary, children }: { summary: MetricSummary; children?: ReactNode }) {
  const execution = summary.execution;
  const evaluation = summary.evaluation;
  const executionInProgress = stageInProgressCount(execution);
  const evaluationInProgress = stageInProgressCount(evaluation);
  return <div className="flex flex-col gap-6">
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      <MetricCard label="采样" value={formatNumber(summary.counts.samplings)} hint={`${summary.counts.projectSamples} 条样本 · ${summary.counts.evaluations} 个评估`} />
      <MetricCard label="执行成功率" value={formatPercent(execution.successRate)} tone={execution.statuses.failed > 0 ? "warning" : undefined}
        hint={`成功 ${execution.statuses.succeeded} · 失败 ${execution.statuses.failed} · 执行中 ${executionInProgress}`} />
      <MetricCard label="评估成功率" value={formatPercent(evaluation.successRate)} tone={evaluation.statuses.failed > 0 ? "warning" : undefined}
        hint={`成功 ${evaluation.statuses.succeeded} · 失败 ${evaluation.statuses.failed} · 评估中 ${evaluationInProgress}`} />
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
          <ResourceMetrics statistics={statistics} distribution={statistics.distribution} durations={stage} stageStatus={stageStatusFor(stage)} showCoverage={false} />
        </AccordionContent>
      </AccordionItem>)}
    </Accordion>
    </details>
  </div>;
}
