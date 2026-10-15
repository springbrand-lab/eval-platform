import type { MetricSummary, NumericOutputSummary, ResourceStatistics } from "@/api-sdk/types";
import { MetricCard } from "@/components/ui/data-display";
import { formatCompact, formatNumber, formatPercent } from "@/lib/format";

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
  const running = execution.records - execution.terminalRecords;
  const invalid = summary.numericOutputs.validation.invalid;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">
      <MetricCard label="采样" value={formatNumber(summary.counts.samplings)}
        hint={`${summary.counts.projectSamples} 条用例 · ${summary.counts.evaluations} 个评估`} />
      <MetricCard label="执行成功率" value={formatPercent(execution.successRate)}
        tone={execution.statuses.failed > 0 ? "warning" : undefined}
        hint={`成功 ${execution.statuses.succeeded} · 失败 ${execution.statuses.failed}${running > 0 ? ` · 进行中 ${running}` : ""}`} />
      <MetricCard label="评估成功率" value={formatPercent(evaluation.successRate)}
        tone={evaluation.statuses.failed > 0 ? "warning" : undefined}
        hint={`成功 ${evaluation.statuses.succeeded} · 失败 ${evaluation.statuses.failed}`} />
      <MetricCard label="平均分" value={score?.summary.mean === null || score?.summary.mean === undefined ? "—" : formatNumber(score.summary.mean, 2)}
        tone={invalid > 0 ? "warning" : undefined}
        hint={score
          ? `${score.contributingEvaluationCount} 个有效评分 · ${formatNumber(score.summary.min, 2)}–${formatNumber(score.summary.max, 2)}${invalid > 0 ? ` · ${invalid} 个格式错误` : ""}`
          : "还没有有效评分"} />
      <MetricCard label="积分消耗" value={formatNumber(chargedUnits(summary.executionAgent, summary.evaluationAgents))}
        hint={`执行 ${formatNumber(summary.executionAgent.costs.chargedUnits.value)} · 评估 ${formatNumber(summary.evaluationAgents.costs.chargedUnits.value)}`} />
      <MetricCard label="Token" value={formatCompact(totalTokens(summary.executionAgent, summary.evaluationAgents))}
        hint={`执行 ${formatCompact(summary.executionAgent.tokens.total.value)} · 评估 ${formatCompact(summary.evaluationAgents.tokens.total.value)}`} />
    </div>
  );
}
