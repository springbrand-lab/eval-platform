import { NativeSelect, NativeSelectOption } from "@springbrand/site-block";
import { useState } from "react";
import type { OperationDistributions, ResourceDistribution, ResourceStatistics } from "@/api-sdk/types";
import { formatDuration, formatMetricBytes } from "@/lib/format";
import { COST_FIELDS, OPERATION_FIELDS, TOKEN_FIELDS } from "./metric-labels";
import { StatisticsTable, type StatisticsRow } from "./statistics-table";

function operationRows(statistics: OperationDistributions): StatisticsRow[] {
  return OPERATION_FIELDS.map(([key, label]) => ({ label, unit: "次", summary: statistics[key] }));
}

function trajectoryRows(distribution: ResourceDistribution): StatisticsRow[] {
  return [
    { label: "处理轮（Turn）", unit: "次", summary: distribution.trajectory.turns.count },
    { label: "思考命中轮", unit: "次", summary: distribution.trajectory.thinkingTurnOperations.count },
    { label: "内容命中轮", unit: "次", summary: distribution.trajectory.contentTurnOperations.count },
    { label: "模型请求", unit: "次", summary: distribution.modelRequests.count },
    { label: "工具调用", unit: "次", summary: distribution.trajectory.tools.count },
  ];
}

function tokenRows(distribution: ResourceDistribution): StatisticsRow[] {
  return TOKEN_FIELDS.map(([key, label]) => ({ label, unit: "Token", summary: distribution.tokens[key] }));
}

function turnTokenRows(distribution: ResourceDistribution): StatisticsRow[] {
  const rows: StatisticsRow[] = [];
  for (const [prefix, tokens] of [["思考轮", distribution.trajectory.thinkingTurnTokens], ["内容轮", distribution.trajectory.contentTurnTokens]] as const) {
    for (const [key, label] of [["input", "输入 Token"], ["output", "输出 Token"], ["total", "总 Token"]] as const) {
      rows.push({ label: `${prefix} · ${label}`, unit: "Token", summary: tokens[key] });
    }
  }
  return rows;
}

function TokenDistribution({ distribution }: { distribution: ResourceDistribution }) {
  return <div className="flex min-w-0 flex-col gap-5">
    <StatisticsTable label="Token 的 Agent 间差异" description="当前入口包含全部 Agent；每个 Agent 合并重试后，再比较 Token 用量的均值、范围和波动。" rows={tokenRows(distribution)} />
    <StatisticsTable label="思考与内容 Token 的 Agent 间差异" description="思考轮和内容轮可以命中同一轮，分类 Token 也可能重叠，不能相加推算总 Token。" rows={turnTokenRows(distribution)} />
  </div>;
}

function CostDistribution({ distribution }: { distribution: ResourceDistribution }) {
  return <StatisticsTable label="费用的 Agent 间差异" description="当前入口包含全部 Agent；积分与 USD 使用各自单位展示，不进行换算或合并。" rows={COST_FIELDS.map(([key, label]) => ({ label, unit: key === "providerUsd" ? "USD" : "积分", summary: distribution.costs[key] }))} />;
}

function TrajectoryDistribution({ distribution }: { distribution: ResourceDistribution }) {
  return <StatisticsTable label="操作次数的 Agent 间差异" description="思考命中轮、内容命中轮和工具调用可以属于同一处理轮，因此这些次数不要求相加等于处理轮。" rows={trajectoryRows(distribution)} />;
}

function ToolDistribution({ tools, lengthTools }: { tools: ResourceDistribution["trajectory"]["byTool"]; lengthTools: ResourceStatistics["trajectory"]["byTool"] }) {
  const [toolIndex, setToolIndex] = useState("0");
  const selectedIndex = Math.min(Math.max(Number(toolIndex) || 0, 0), tools.length - 1);
  const tool = tools[selectedIndex]!;
  const name = tool.toolName ?? "未识别工具";
  const lengthTool = lengthTools.find((item) => item.toolName === tool.toolName);
  const rows: StatisticsRow[] = [
    ...operationRows(tool.operations),
    ...(lengthTool ? [
      { label: "请求大小", unit: "字节", summary: lengthTool.inputLength, format: formatMetricBytes },
      { label: "返回大小", unit: "字节", summary: lengthTool.outputLength, format: formatMetricBytes },
      { label: "调用耗时", unit: "毫秒", summary: lengthTool.durationMs, format: formatDuration },
    ] : []),
  ];
  return <section aria-label="工具明细" className="min-w-0 space-y-3">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div><h4 className="text-sm font-semibold text-text-strong">工具明细</h4><p className="mt-1 text-xs leading-5 text-text-muted">选择具体工具，查看它在全部 Agent 中的调用结果和单次调用表现。</p></div>
      <div className="flex min-w-0 sm:shrink-0">
        <NativeSelect aria-label="选择工具" className="max-w-full sm:min-w-48" value={String(selectedIndex)} onChange={(event) => setToolIndex(event.target.value)}>
          {tools.map((item, index) => <NativeSelectOption key={`${item.toolName ?? "unknown"}-${index}`} value={String(index)}>{item.toolName ?? "未识别工具"}</NativeSelectOption>)}
        </NativeSelect>
      </div>
    </div>
    <StatisticsTable label={`工具 ${name} 明细`} description="次数按工具调用统计；大小按单次请求或返回统计；缺失不补零。" rows={rows} showHeader={false} />
  </section>;
}

export type ResourceDistributionSection = "costs" | "tokens" | "operations";

/** Agent-level observations are shown inside the selected metric, without a separate scope switch. */
export function ResourceDistributionPanel({ distribution, statistics, section }: { distribution: ResourceDistribution; statistics: ResourceStatistics; section: ResourceDistributionSection }) {
  return <section aria-label={`${section === "costs" ? "费用" : section === "tokens" ? "Token" : "操作次数"}的 Agent 间差异`} className="flex min-w-0 flex-col gap-5">
    {section === "costs" && <CostDistribution distribution={distribution} />}
    {section === "tokens" && <TokenDistribution distribution={distribution} />}
    {section === "operations" && <>
      <TrajectoryDistribution distribution={distribution} />
      {distribution.trajectory.byTool.length > 0 && <ToolDistribution tools={distribution.trajectory.byTool} lengthTools={statistics.trajectory.byTool} />}
    </>}
  </section>;
}
