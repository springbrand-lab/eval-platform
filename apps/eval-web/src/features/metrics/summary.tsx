import type { MetricSummary, NumericOutputSummary, ResourceStatistics } from "@/api-sdk/types";
import { MetricCard } from "@/components/ui/data-display";
import { formatNumber, formatPercent } from "@/lib/format";

/** The judge score field: `/score` when the Schema has one, else the first numeric field. */
export function scoreField(outputs: NumericOutputSummary) {
  return outputs.fields.find((field) => field.jsonPointer === "/score") ?? outputs.fields[0] ?? null;
}

export function chargedUnits(...stats: readonly ResourceStatistics[]): number | null {
  const values = stats.map((item) => item.costs.chargedUnits.value).filter((value): value is number => value !== null);
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null;
}

export function totalTokens(...stats: readonly ResourceStatistics[]): number | null {
  const values = stats.map((item) => item.tokens.total.value).filter((value): value is number => value !== null);
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null;
}

export function SummaryCards({ summary }: { summary: MetricSummary }) {
  const score = scoreField(summary.numericOutputs);
  const execution = summary.execution;
  const evaluation = summary.evaluation;
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
      <MetricCard label="采样" value={formatNumber(summary.counts.samplings)} hint={`${summary.counts.projectSamples} 条用例`} />
      <MetricCard label="执行成功率" value={formatPercent(execution.successRate)}
        tone={execution.successRate !== null && execution.successRate < 1 ? "warning" : undefined}
        hint={`成功 ${execution.statuses.succeeded} · 失败 ${execution.statuses.failed} · 进行中 ${execution.records - execution.terminalRecords}`} />
      <MetricCard label="评估成功率" value={formatPercent(evaluation.successRate)}
        hint={`成功 ${evaluation.statuses.succeeded} · 失败 ${evaluation.statuses.failed}`} />
      <MetricCard label={score ? `平均分（${score.jsonPointer.replace(/^\//u, "")}）` : "平均分"}
        value={score?.summary.mean === null || score?.summary.mean === undefined ? "—" : formatNumber(score.summary.mean, 2)}
        hint={score ? `${score.contributingEvaluationCount} 个有效评分 · 最低 ${formatNumber(score.summary.min, 2)} · 最高 ${formatNumber(score.summary.max, 2)}` : "还没有有效评分"} />
      <MetricCard label="积分消耗" value={formatNumber(chargedUnits(summary.executionAgent, summary.evaluationAgents))}
        hint={`执行 ${formatNumber(summary.executionAgent.costs.chargedUnits.value)} · 评估 ${formatNumber(summary.evaluationAgents.costs.chargedUnits.value)}`} />
      <MetricCard label="Token" value={formatNumber(totalTokens(summary.executionAgent, summary.evaluationAgents))}
        hint={`格式错误的评委结果 ${summary.numericOutputs.validation.invalid} 个`} />
    </div>
  );
}
