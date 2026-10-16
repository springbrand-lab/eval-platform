import type { EvaluationOutputSummary, MetricSummary, OutputFieldSummary } from "@/api-sdk/types";
import { MetricCard } from "@/components/ui/data-display";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/badge";
import { formatCompact, formatDuration, formatNumber, formatPercent, formatStatistic } from "@/lib/format";
import { AgentMetricPair } from "./metric-value";
import { NumericMetrics, ResourceMetrics } from "./resource-metrics";

function fieldValue(field: OutputFieldSummary): string {
  const values: string[] = [];
  if (field.numeric) values.push(`均值 ${formatStatistic(field.numeric.mean)} · 方差 ${formatStatistic(field.numeric.variance)} · 中位数 ${formatStatistic(field.numeric.median)} · 最小 ${formatStatistic(field.numeric.min)} · 最大 ${formatStatistic(field.numeric.max)}`);
  values.push(...field.distribution.map((item) => `${JSON.stringify(item.value)}: ${item.count} (${formatPercent(item.share)})`));
  if (field.nullCount !== undefined) values.push(`null: ${field.nullCount}`);
  return values.join(" · ") || "暂无有效观察";
}

/** Compact projection of every field supplied by the same server-side presentation plan. */
export function OutputPreview({ outputs }: { outputs: EvaluationOutputSummary }) {
  return <div className="flex flex-col gap-1 text-xs">{outputs.fields.length === 0 ? "暂无可统计字段" : outputs.fields.map((field) => (
    <span key={field.jsonPointer}><strong>{field.title}</strong>：{fieldValue(field)}</span>
  ))}</div>;
}

export function OutputFields({ outputs }: { outputs: EvaluationOutputSummary }) {
  return <Card>
    <CardHeader title="Schema 评估输出" description={`有效 ${outputs.validation.valid} · 无效 ${outputs.validation.invalid} · 未获得 ${outputs.validation.unavailable}`} />
    <CardBody className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {outputs.fields.length === 0 && <p className="text-sm text-text-muted">暂无可统计字段。原始结果可在采样详情查看。</p>}
      {outputs.fields.map((field) => <section key={field.jsonPointer} className="rounded-lg border border-border p-3">
        <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">{field.title}</h3>{field.coverage !== "complete" && <StatusBadge status={field.coverage} />}</div>
        <p className="mt-1 text-xs text-text-muted">{field.description}</p>
        <p className="mt-1 break-all font-mono text-xs text-text-muted">{field.jsonPointer || "$"} · {field.kinds.join(" / ")}</p>
        <p className="mt-3 text-sm">{fieldValue(field)}</p>
        {field.numeric && <p className="mt-1 text-xs text-text-muted">有效数值 N = {field.numeric.count}</p>}
        <p className="mt-2 text-xs text-text-muted">{field.contributingEvaluationCount} 份评估 · {field.observationCount} 个观察值 · 缺失 {field.missingEvaluationCount} 份</p>
        {field.diagnostics.length > 0 && <p className="mt-1 text-xs text-text-muted">{field.diagnostics.map((item) => `${MISSING[item.reason]} ${item.evaluations}`).join(" · ")}</p>}
      </section>)}
    </CardBody>
  </Card>;
}

const MISSING = { "not-succeeded": "评估未成功", "invalid-output": "结果无效", "unavailable-output": "结果未获得", absent: "字段缺失" };

export function SummaryCards({ summary }: { summary: MetricSummary }) {
  const execution = summary.execution;
  const evaluation = summary.evaluation;
  const running = execution.records - execution.terminalRecords;
  return <div className="flex flex-col gap-4">
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      <MetricCard label="采样" value={formatNumber(summary.counts.samplings)} hint={`${summary.counts.projectSamples} 条样本 · ${summary.counts.evaluations} 个评估`} />
      <MetricCard label="执行成功率" value={formatPercent(execution.successRate)} tone={execution.statuses.failed > 0 ? "warning" : undefined}
        hint={`成功 ${execution.statuses.succeeded} · 失败 ${execution.statuses.failed} · 进行中 ${running}`} />
      <MetricCard label="评估成功率" value={formatPercent(evaluation.successRate)} tone={evaluation.statuses.failed > 0 ? "warning" : undefined}
        hint={`成功 ${evaluation.statuses.succeeded} · 失败 ${evaluation.statuses.failed}`} />
      <MetricCard label="积分消耗" value={<AgentMetricPair execution={summary.executionAgent.costs.chargedUnits} evaluation={summary.evaluationAgents.costs.chargedUnits} />} />
      <MetricCard label="Token" value={<AgentMetricPair execution={summary.executionAgent.tokens.total} evaluation={summary.evaluationAgents.tokens.total} format={formatCompact} />} />
    </div>
    <div className="grid gap-4">
      {([
        ["执行 Agent", summary.executionAgent, execution],
        ["评估 Agent", summary.evaluationAgents, evaluation],
      ] as const).map(([title, statistics, stage]) => <Card key={title}>
        <CardHeader title={`${title} 资源与轨迹`} />
        <CardBody className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div><h3 className="mb-2 text-sm font-semibold">Agent 耗时</h3><NumericMetrics summary={stage.agentDurationMs} format={formatDuration} varianceUnit="毫秒²" /></div>
            <div><h3 className="mb-2 text-sm font-semibold">单次尝试耗时</h3><NumericMetrics summary={stage.attemptDurationMs} format={formatDuration} varianceUnit="毫秒²" /></div>
          </div>
          <ResourceMetrics statistics={statistics} distribution={statistics.distribution} />
        </CardBody>
      </Card>)}
    </div>
    <OutputFields outputs={summary.evaluationOutputs} />
  </div>;
}
