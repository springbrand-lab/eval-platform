import type { EvaluationOutputSummary, MetricSummary, OutputFieldSummary, ResourceStatistics } from "@/api-sdk/types";
import { MetricCard } from "@/components/ui/data-display";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/badge";
import { formatCompact, formatNumber, formatPercent } from "@/lib/format";

function fieldValue(field: OutputFieldSummary): string {
  const values: string[] = [];
  if (field.numeric) values.push(`均值 ${formatNumber(field.numeric.mean, 2)}`);
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
        <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">{field.title}</h3><StatusBadge status={field.coverage} /></div>
        <p className="mt-1 text-xs text-text-muted">{field.description}</p>
        <p className="mt-1 break-all font-mono text-xs text-text-muted">{field.jsonPointer || "$"} · {field.kinds.join(" / ")}</p>
        <p className="mt-3 text-sm">{fieldValue(field)}</p>
        {field.numeric && <p className="mt-1 text-xs text-text-muted">最小 {formatNumber(field.numeric.min, 2)} · 最大 {formatNumber(field.numeric.max, 2)}</p>}
        <p className="mt-2 text-xs text-text-muted">{field.contributingEvaluationCount} 份评估 · {field.observationCount} 个观察值 · 缺失 {field.missingEvaluationCount} 份</p>
        {field.diagnostics.length > 0 && <p className="mt-1 text-xs text-text-muted">{field.diagnostics.map((item) => `${MISSING[item.reason]} ${item.evaluations}`).join(" · ")}</p>}
      </section>)}
    </CardBody>
  </Card>;
}

const MISSING = { "not-succeeded": "评估未成功", "invalid-output": "结果无效", "unavailable-output": "结果未获得", absent: "字段缺失" };

export function chargedUnits(...stats: readonly ResourceStatistics[]): number | null {
  const values = stats.map((item) => item.costs.chargedUnits.value).filter((value): value is number => value !== null);
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null;
}

export function totalTokens(...stats: readonly ResourceStatistics[]): number | null {
  const values = stats.map((item) => item.tokens.total.value).filter((value): value is number => value !== null);
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null;
}

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
      <MetricCard label="积分消耗" value={formatNumber(chargedUnits(summary.executionAgent, summary.evaluationAgents))}
        hint={`执行 ${formatNumber(summary.executionAgent.costs.chargedUnits.value)} · 评估 ${formatNumber(summary.evaluationAgents.costs.chargedUnits.value)}`} />
      <MetricCard label="Token" value={formatCompact(totalTokens(summary.executionAgent, summary.evaluationAgents))}
        hint={`执行 ${formatCompact(summary.executionAgent.tokens.total.value)} · 评估 ${formatCompact(summary.evaluationAgents.tokens.total.value)}`} />
    </div>
    <OutputFields outputs={summary.evaluationOutputs} />
  </div>;
}
