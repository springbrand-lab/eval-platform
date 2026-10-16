import type { OperationDistributions, ResourceDistribution } from "@/api-sdk/types";
import { COST_FIELDS, OPERATION_FIELDS, TOKEN_FIELDS } from "./metric-labels";
import { StatisticsTable, type StatisticsRow } from "./statistics-table";

function operationRows(prefix: string, statistics: OperationDistributions): StatisticsRow[] {
  return OPERATION_FIELDS.map(([key, label]) => ({ label: `${prefix} · ${label}`, unit: "次", summary: statistics[key] }));
}

/** Resource statistics use single-Agent observations, not child-scope totals or the visible trajectory page. */
export function ResourceDistributionPanel({ distribution }: { distribution: ResourceDistribution }) {
  return <div className="flex min-w-0 flex-col gap-7">
        <p className="rounded-lg bg-surface-muted px-4 py-3 text-[13px] leading-6 text-text-secondary">统计对象：{distribution.records} 个 Agent（每个 Agent 合并其重试）。以下比较单个 Agent 的消耗与调用次数，不是项目总量，也不是已加载的轨迹事件数量。</p>
        <StatisticsTable label="Agent Token 与缓存分布" description="每个 Agent 的 Token 消耗；缓存与推理不重复计入总量。" rows={TOKEN_FIELDS.map(([key, label]) => ({ label, unit: "Token", summary: distribution.tokens[key] }))} />
        <StatisticsTable label="Agent 积分与成本分布" description="每个 Agent 的费用。USD 与积分分别展示，不进行换算或合并。" rows={COST_FIELDS.map(([key, label]) => ({ label, unit: key === "providerUsd" ? "USD" : "积分", summary: distribution.costs[key] }))} />
        <StatisticsTable label="Agent 轨迹次数分布" description="每个 Agent 的操作次数和非工具轮 Token；不按下层汇总值再次求平均。" rows={[
          ...operationRows("轮次", distribution.trajectory.turns), ...operationRows("工具调用", distribution.trajectory.tools), ...operationRows("模型请求", distribution.modelRequests),
          { label: "非工具轮数", unit: "次", summary: distribution.trajectory.nonToolTurns },
          ...(["input", "output", "total"] as const).map((key, index) => ({ label: ["非工具轮输入 Token", "非工具轮输出 Token", "非工具轮总 Token"][index]!, unit: "Token", summary: distribution.trajectory.nonToolTurnTokens[key] })),
        ]} />
        {distribution.trajectory.byTool.map((tool) => <StatisticsTable key={JSON.stringify(tool.toolName)} label={`工具 ${tool.toolName ?? "未识别工具"} 的 Agent 分布`}
          description="每个 Agent 对该工具的调用次数，区别于单次调用的长度和耗时。" rows={operationRows(tool.toolName ?? "未识别工具", tool.operations)} />)}
  </div>;
}
