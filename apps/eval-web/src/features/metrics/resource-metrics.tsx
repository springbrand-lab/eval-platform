import {
  Button, Collapsible, CollapsibleContent, CollapsibleTrigger, Tabs, TabsContent, TabsList, TabsTrigger,
  Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow,
} from "@springbrand/site-block";
import { ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { OperationStatistics, ResourceDistribution, ResourceStatistics, StageStatistics } from "@/api-sdk/types";
import { StatusBadge } from "@/components/ui/badge";
import { DescriptionList } from "@/components/ui/card";
import { formatBytes, formatDuration, formatStatistic, formatUsd } from "@/lib/format";
import { MetricValue } from "./metric-value";
import { TokenMetrics } from "./token-metrics";
import { COST_FIELDS } from "./metric-labels";
import { ResourceDistributionPanel } from "./resource-distribution";
import { StatisticsTable } from "./statistics-table";

function MetricDisclosure({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <Collapsible className="rounded-lg border border-border">
    <CollapsibleTrigger asChild>
      <Button type="button" variant="ghost" className="group h-auto w-full justify-between gap-4 whitespace-normal rounded-lg px-4 py-3 text-left">
        <span className="min-w-0"><span className="block text-sm font-medium">{title}</span><span className="mt-1 block text-xs font-normal leading-5 text-text-muted">{description}</span></span>
        <ChevronDown className="size-4 shrink-0 text-text-muted transition-transform group-aria-expanded:rotate-180" />
      </Button>
    </CollapsibleTrigger>
    <CollapsibleContent keepMounted><div className="min-w-0 border-t border-border p-4">{children}</div></CollapsibleContent>
  </Collapsible>;
}

function OperationsTable({ label, caption, rows }: { label: string; caption: string; rows: readonly { label: string; value: OperationStatistics }[] }) {
  return <div className="overflow-hidden rounded-lg border border-border">
    <Table aria-label={label} className="text-[13px]">
      <TableCaption className="m-0 border-t border-border px-4 py-2 text-left text-xs">{caption}</TableCaption>
      <TableHeader className="bg-surface-muted/60"><TableRow>
        {["类别", "次数", "成功", "失败", "取消", "进行中", "未知"].map((name, index) => <TableHead key={name} scope="col" className={index === 0 ? "px-4 text-xs" : "text-right text-xs"}>{name}</TableHead>)}
      </TableRow></TableHeader>
      <TableBody>{rows.length === 0 ? <TableRow><TableCell colSpan={7} className="px-4 py-6 text-center text-text-muted">暂无工具类型数据</TableCell></TableRow> : rows.map(({ label: name, value }, index) => <TableRow key={`${name}-${index}`}>
        <TableHead scope="row" className="max-w-64 whitespace-normal break-words px-4 py-3 font-medium text-text-strong">{name}</TableHead>
        <TableCell className="text-right font-semibold tabular-nums"><MetricValue metric={value.count} /></TableCell>
        <TableCell className="text-right tabular-nums">{value.completed}</TableCell>
        <TableCell className={`text-right tabular-nums ${value.failed > 0 ? "font-medium text-danger" : "text-text-muted"}`}>{value.failed}</TableCell>
        <TableCell className="text-right tabular-nums text-text-muted">{value.cancelled}</TableCell>
        <TableCell className="text-right tabular-nums">{value.inProgress}</TableCell>
        <TableCell className="text-right tabular-nums text-text-muted">{value.unknown}</TableCell>
      </TableRow>)}</TableBody>
    </Table>
  </div>;
}

function TrajectoryMetrics({ trajectory, modelRequests }: Pick<ResourceStatistics, "trajectory" | "modelRequests">) {
  const bytes = (value: number) => value < 1024 ? `${formatStatistic(value)} B` : formatBytes(value);
  const operations = [
    { label: "轨迹轮数", value: trajectory.turns },
    { label: "工具调用", value: trajectory.tools },
    { label: "模型请求", value: modelRequests },
  ];
  return <section aria-label="轨迹统计" className="flex min-w-0 flex-col gap-4">
    <div><h3 className="text-sm font-semibold text-text-strong">轨迹与调用</h3><p className="mt-1 text-xs text-text-muted">先看操作结果，耗时与工具大小按需展开。</p></div>
    <OperationsTable label="轨迹操作" caption="轮数按 Turn 计数，工具和模型按调用操作计数。" rows={operations} />
    <MetricDisclosure title="操作耗时" description="按单次操作查看累计、典型耗时和范围。累计不代表并行运行的墙钟时间。">
      <StatisticsTable label="操作耗时分布" total description="观察单位：每次轮次、工具或模型操作；各项分别保留有效 N 和缺失。" rows={operations.map(({ label, value }) => ({
        label, unit: "毫秒", summary: value.durationMs, format: formatDuration,
      }))} />
    </MetricDisclosure>
    <div className="mt-2"><h3 className="mb-3 text-sm font-semibold text-text-strong">工具类型</h3>
      <OperationsTable label="工具类型统计" caption="每种工具的累计调用结果；未知不计为成功或失败。" rows={trajectory.byTool.map((tool) => ({ label: tool.toolName ?? "未识别工具", value: tool }))} />
    </div>
    {trajectory.byTool.length > 0 && <MetricDisclosure title="工具长度与耗时" description="按单次工具调用统计。调用和返回长度使用 UTF-8 字节，不换算为 Token。">
      <StatisticsTable label="工具长度与耗时分布" total description="累计与单次调用分布分列展示；未获得或脱敏正文不按零计数。" rows={trajectory.byTool.flatMap((tool) => [
        { label: `${tool.toolName ?? "未识别工具"} · 调用长度`, unit: "字节", summary: tool.inputLength, format: bytes },
        { label: `${tool.toolName ?? "未识别工具"} · 返回长度`, unit: "字节", summary: tool.outputLength, format: bytes },
        { label: `${tool.toolName ?? "未识别工具"} · 耗时`, unit: "毫秒", summary: tool.durationMs, format: formatDuration },
      ])} />
    </MetricDisclosure>}
    <dl className="mt-2 grid grid-cols-2 gap-4 rounded-lg bg-surface-muted/60 p-4 lg:grid-cols-4">
      {([
        ["非工具轮数", trajectory.nonToolTurns], ["非工具轮总 Token", trajectory.nonToolTurnTokens.total],
        ["非工具轮输入 Token", trajectory.nonToolTurnTokens.input], ["非工具轮输出 Token", trajectory.nonToolTurnTokens.output],
      ] as const).map(([label, metric]) => <div key={label}>
        <dt className="text-xs text-text-muted">{label}</dt>
        <dd className="mt-1 font-medium"><MetricValue metric={metric} /></dd>
      </div>)}
    </dl>
    {(trajectory.unlinkedOperations.tools > 0 || trajectory.unlinkedOperations.generations > 0) && <p className="text-xs text-muted-foreground">
      未关联到轮次的工具 {trajectory.unlinkedOperations.tools} 次、模型请求 {trajectory.unlinkedOperations.generations} 次，非工具轮统计可能不完整。
    </p>}
  </section>;
}

/** The same raw-fact projection for one Agent and every aggregation scope. */
export function ResourceMetrics({ statistics, distribution, durations, showCoverage = true }: {
  statistics: ResourceStatistics; distribution?: ResourceDistribution;
  durations?: Pick<StageStatistics, "agentDurationMs" | "attemptDurationMs">;
  showCoverage?: boolean;
}) {
  const [distributionVisited, setDistributionVisited] = useState(false);
  const totals = <div className="flex min-w-0 flex-col gap-6">
    <section aria-label="费用" className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-text-strong">费用</h3>
      <dl className="grid grid-cols-1 gap-4 rounded-lg bg-surface-muted/60 p-4 sm:grid-cols-2">
        <div><dt className="text-xs text-text-muted">实际积分</dt><dd className="mt-2 text-xl font-semibold tabular-nums"><MetricValue metric={statistics.costs.chargedUnits} format={formatStatistic} /></dd></div>
        <div><dt className="text-xs text-text-muted">模型成本 · USD</dt><dd className="mt-2 text-xl font-semibold tabular-nums"><MetricValue metric={statistics.costs.providerUsd} format={formatUsd} /></dd></div>
      </dl>
      <MetricDisclosure title="积分构成与计价记录" description="模型、Action、计价与实际扣除分别记录，不将这些字段重复相加。">
        <DescriptionList items={COST_FIELDS.filter(([key]) => key !== "chargedUnits" && key !== "providerUsd").map(([key, label]) => ({
          label, value: <MetricValue metric={statistics.costs[key]} format={formatStatistic} />,
        }))} />
      </MetricDisclosure>
    </section>
    <TokenMetrics statistics={statistics} />
    <TrajectoryMetrics trajectory={statistics.trajectory} modelRequests={statistics.modelRequests} />
  </div>;
  return <div className="flex min-w-0 flex-col gap-5">
    {showCoverage && <dl className="flex flex-wrap items-center gap-2 text-xs"><dt className="text-text-muted">资源完整性</dt><dd><StatusBadge status={statistics.coverage} /></dd></dl>}
    {distribution ? <Tabs defaultValue="totals" onValueChange={(value) => { if (value === "distribution") setDistributionVisited(true); }}>
      <TabsList variant="line" aria-label="统计视图" className="mb-4 w-full justify-start border-b border-border">
        <TabsTrigger value="totals" className="flex-none px-4">累计概览</TabsTrigger>
        <TabsTrigger value="distribution" className="flex-none px-4">分布统计</TabsTrigger>
      </TabsList>
      <TabsContent value="totals" keepMounted>{totals}</TabsContent>
      <TabsContent value="distribution" keepMounted>
        {distributionVisited && <div className="flex min-w-0 flex-col gap-7">
          {durations && <StatisticsTable label="Agent 与尝试耗时" total
            description="Agent 耗时按单个 Agent 统计；尝试耗时按每次尝试统计。累计是耗时之和，不代表并行批次的墙钟时间。" rows={[
              { label: "Agent 耗时", unit: "毫秒", summary: durations.agentDurationMs, format: formatDuration },
              { label: "单次尝试耗时", unit: "毫秒", summary: durations.attemptDurationMs, format: formatDuration },
            ]} />}
          <ResourceDistributionPanel distribution={distribution} />
        </div>}
      </TabsContent>
    </Tabs> : totals}
    {statistics.diagnostics.length > 0 && <MetricDisclosure title={`统计诊断（${statistics.diagnostics.length}）`} description="查看缺失来源、重复记录和其他统计诊断。">
      <ul className="list-inside list-disc text-xs leading-6 text-text-muted">{statistics.diagnostics.map((item, index) => <li key={index}>{item.stream} · {item.eventId ?? item.kind} · {item.message}</li>)}</ul>
    </MetricDisclosure>}
  </div>;
}
