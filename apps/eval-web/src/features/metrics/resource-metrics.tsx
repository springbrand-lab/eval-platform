import {
  Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow,
} from "@springbrand/site-block";
import type { NumericSummary, ResourceDistribution, ResourceStatistics } from "@/api-sdk/types";
import { StatusBadge } from "@/components/ui/badge";
import { DescriptionList } from "@/components/ui/card";
import { formatBytes, formatDuration, formatStatistic, formatUsd } from "@/lib/format";
import { MetricValue } from "./metric-value";
import { TokenMetrics } from "./token-metrics";
import { COST_FIELDS } from "./metric-labels";
import { ResourceDistributionPanel } from "./resource-distribution";

export function NumericMetrics({ summary, format = formatStatistic, varianceUnit = "" }: { summary: NumericSummary; format?: (value: number) => string; varianceUnit?: string }) {
  const show = (value: number | null) => value === null ? "未获得" : format(value);
  return <span className="inline-flex flex-col gap-1 text-xs">
    <span>累计 {show(summary.total)} · 均值 {show(summary.mean)}</span>
    <span>方差 {formatStatistic(summary.variance)}{summary.variance !== null && varianceUnit ? ` ${varianceUnit}` : ""} · 中位数 {show(summary.median)}</span>
    <span>最小 {show(summary.min)} · 最大 {show(summary.max)}</span>
    <span className="text-muted-foreground">有效 {summary.count} · 缺失 {summary.missing}</span>
  </span>;
}

function TrajectoryMetrics({ trajectory, modelRequests }: Pick<ResourceStatistics, "trajectory" | "modelRequests">) {
  const operations = [
    { label: "轨迹轮数", value: trajectory.turns },
    { label: "工具调用", value: trajectory.tools },
    { label: "模型请求", value: modelRequests },
  ];
  return <section aria-label="轨迹统计" className="flex flex-col gap-3">
    <div className="flex items-center gap-2"><h3 className="text-sm font-semibold">轨迹统计</h3><StatusBadge status={trajectory.coverage} /></div>
    <Table aria-label="轨迹操作">
      <TableCaption>轮数按 Turn 计数，工具按调用操作计数；累计耗时是各次操作耗时之和。</TableCaption>
      <TableHeader><TableRow>
        {["类别", "次数", "成功", "失败", "取消", "进行中", "未知", "耗时"].map((label) => <TableHead key={label} scope="col">{label}</TableHead>)}
      </TableRow></TableHeader>
      <TableBody>{operations.map(({ label, value }) => <TableRow key={label}>
        <TableHead scope="row">{label}</TableHead><TableCell><MetricValue metric={value.count} /></TableCell>
        <TableCell>{value.completed}</TableCell><TableCell>{value.failed}</TableCell><TableCell>{value.cancelled}</TableCell>
        <TableCell>{value.inProgress}</TableCell><TableCell>{value.unknown}</TableCell>
        <TableCell><NumericMetrics summary={value.durationMs} format={formatDuration} varianceUnit="毫秒²" /></TableCell>
      </TableRow>)}</TableBody>
    </Table>
    <DescriptionList items={[
      { label: "非工具轮数", value: <MetricValue metric={trajectory.nonToolTurns} /> },
      { label: "非工具轮总 Token", value: <MetricValue metric={trajectory.nonToolTurnTokens.total} /> },
      { label: "非工具轮输入 Token", value: <MetricValue metric={trajectory.nonToolTurnTokens.input} /> },
      { label: "非工具轮输出 Token", value: <MetricValue metric={trajectory.nonToolTurnTokens.output} /> },
    ]} />
    <Table aria-label="工具类型统计">
      <TableCaption>调用和返回长度为规范 JSON 的 UTF-8 字节数；未获得或脱敏正文不按零计数。</TableCaption>
      <TableHeader><TableRow>
        {["工具类型", "调用次数", "成功", "失败", "取消", "进行中", "未知", "调用长度", "返回长度", "耗时"].map((label) => <TableHead key={label} scope="col">{label}</TableHead>)}
      </TableRow></TableHeader>
      <TableBody>{trajectory.byTool.length === 0 ? <TableRow><TableCell colSpan={10}>暂无工具类型数据</TableCell></TableRow> : trajectory.byTool.map((tool) => <TableRow key={JSON.stringify(tool.toolName)}>
        <TableHead scope="row">{tool.toolName ?? "未识别工具"}</TableHead><TableCell><MetricValue metric={tool.count} /></TableCell>
        <TableCell>{tool.completed}</TableCell><TableCell>{tool.failed}</TableCell><TableCell>{tool.cancelled}</TableCell>
        <TableCell>{tool.inProgress}</TableCell><TableCell>{tool.unknown}</TableCell>
        <TableCell><NumericMetrics summary={tool.inputLength} format={formatBytes} varianceUnit="字节²" /><StatusBadge status={tool.inputLength.coverage} /></TableCell>
        <TableCell><NumericMetrics summary={tool.outputLength} format={formatBytes} varianceUnit="字节²" /><StatusBadge status={tool.outputLength.coverage} /></TableCell>
        <TableCell><NumericMetrics summary={tool.durationMs} format={formatDuration} varianceUnit="毫秒²" /></TableCell>
      </TableRow>)}</TableBody>
    </Table>
    {(trajectory.unlinkedOperations.tools > 0 || trajectory.unlinkedOperations.generations > 0) && <p className="text-xs text-muted-foreground">
      未关联到轮次的工具 {trajectory.unlinkedOperations.tools} 次、模型请求 {trajectory.unlinkedOperations.generations} 次，非工具轮统计可能不完整。
    </p>}
  </section>;
}

/** The same raw-fact projection for one Agent and every aggregation scope. */
export function ResourceMetrics({ statistics, distribution }: { statistics: ResourceStatistics; distribution?: ResourceDistribution }) {
  return <div className="flex min-w-0 flex-col gap-5">
    <DescriptionList items={[
      { label: "资源完整性", value: <StatusBadge status={statistics.coverage} /> },
      ...COST_FIELDS.map(([key, label]) => ({ label, value: <MetricValue metric={statistics.costs[key]} format={key === "providerUsd" ? formatUsd : formatStatistic} /> })),
    ]} />
    <TokenMetrics statistics={statistics} />
    <TrajectoryMetrics trajectory={statistics.trajectory} modelRequests={statistics.modelRequests} />
    {distribution && <ResourceDistributionPanel distribution={distribution} />}
    {statistics.diagnostics.length > 0 && <details>
      <summary className="cursor-pointer text-sm">统计诊断（{statistics.diagnostics.length}）</summary>
      <ul className="mt-2 list-inside list-disc text-xs text-muted-foreground">{statistics.diagnostics.map((item, index) => <li key={index}>{item.stream} · {item.eventId ?? item.kind} · {item.message}</li>)}</ul>
    </details>}
  </div>;
}
