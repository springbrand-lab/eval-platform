import {
  Button, Collapsible, CollapsibleContent, CollapsibleTrigger,
  Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow,
} from "@springbrand/site-block";
import { ChevronRight } from "lucide-react";
import type { CoveredNumericSummary, OperationDistributions, ResourceDistribution } from "@/api-sdk/types";
import { StatusBadge } from "@/components/ui/badge";
import { formatStatistic } from "@/lib/format";
import { COST_FIELDS, OPERATION_FIELDS, TOKEN_FIELDS } from "./metric-labels";

interface DistributionRow { readonly label: string; readonly unit: string; readonly summary: CoveredNumericSummary }

function DistributionTable({ label, rows }: { label: string; rows: readonly DistributionRow[] }) {
  return <Table aria-label={label}>
    <TableCaption>{label}。均值、总体方差和中位数只统计有效 N，方差单位为原单位的平方。</TableCaption>
    <TableHeader><TableRow>
      {["指标", "单位", "均值", "方差", "中位数", "最小值", "最大值", "有效 N", "缺失", "完整性"].map((name) => <TableHead key={name} scope="col">{name}</TableHead>)}
    </TableRow></TableHeader>
    <TableBody>{rows.map(({ label: name, unit, summary }) => <TableRow key={name}>
      <TableHead scope="row">{name}</TableHead><TableCell>{unit}</TableCell>
      {(["mean", "variance", "median", "min", "max"] as const).map((key) => <TableCell key={key} className="tabular-nums">{formatStatistic(summary[key])}</TableCell>)}
      <TableCell>{summary.count}</TableCell><TableCell>{summary.missing}</TableCell><TableCell><StatusBadge status={summary.coverage} /></TableCell>
    </TableRow>)}</TableBody>
  </Table>;
}

function operationRows(prefix: string, statistics: OperationDistributions): DistributionRow[] {
  return OPERATION_FIELDS.map(([key, label]) => ({ label: `${prefix} · ${label}`, unit: "次", summary: statistics[key] }));
}

/** Resource statistics use single-Agent observations, not child-scope totals or the visible trajectory page. */
export function ResourceDistributionPanel({ distribution }: { distribution: ResourceDistribution }) {
  return <Collapsible>
    <CollapsibleTrigger asChild><Button type="button" variant="outline" className="group">
      <ChevronRight className="size-4 group-data-open:rotate-90" />均值、方差、中位数与范围
    </Button></CollapsibleTrigger>
    <CollapsibleContent>
      <div className="mt-4 flex min-w-0 flex-col gap-4">
        <p className="text-xs text-muted-foreground">按单次 Agent 统计，共 {distribution.records} 个 Agent。缺失不补零，真实零参与；每项分别显示有效 N。</p>
        <DistributionTable label="Agent Token 与缓存分布" rows={TOKEN_FIELDS.map(([key, label]) => ({ label, unit: "Token", summary: distribution.tokens[key] }))} />
        <DistributionTable label="Agent 积分与成本分布" rows={COST_FIELDS.map(([key, label]) => ({ label, unit: key === "providerUsd" ? "USD" : "积分", summary: distribution.costs[key] }))} />
        <DistributionTable label="Agent 轨迹次数分布" rows={[
          ...operationRows("轮次", distribution.trajectory.turns), ...operationRows("工具调用", distribution.trajectory.tools), ...operationRows("模型请求", distribution.modelRequests),
          { label: "非工具轮数", unit: "次", summary: distribution.trajectory.nonToolTurns },
          ...(["input", "output", "total"] as const).map((key, index) => ({ label: ["非工具轮输入 Token", "非工具轮输出 Token", "非工具轮总 Token"][index]!, unit: "Token", summary: distribution.trajectory.nonToolTurnTokens[key] })),
        ]} />
        {distribution.trajectory.byTool.map((tool) => <DistributionTable key={JSON.stringify(tool.toolName)} label={`工具 ${tool.toolName ?? "未识别工具"} 的 Agent 分布`} rows={operationRows(tool.toolName ?? "未识别工具", tool.operations)} />)}
        {distribution.byModel.map((model) => <DistributionTable key={JSON.stringify([model.provider, model.model])} label={`${model.provider ?? "未标识提供方"} / ${model.model ?? "未标识模型"} 的 Agent 分布`} rows={[
          ...TOKEN_FIELDS.map(([key, label]) => ({ label, unit: "Token", summary: model.tokens[key] })),
          { label: "模型成本", unit: "USD", summary: model.providerUsd },
        ]} />)}
      </div>
    </CollapsibleContent>
  </Collapsible>;
}
