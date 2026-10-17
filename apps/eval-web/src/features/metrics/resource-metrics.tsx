import {
  Button, Collapsible, CollapsibleContent, CollapsibleTrigger,
  Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow,
} from "@springbrand/site-block";
import { Check, ChevronDown, Clock3, Coins, ListChecks, Sigma } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { OperationStatistics, ResourceDistribution, ResourceStatistics, StageStatistics } from "@/api-sdk/types";
import { StatusBadge } from "@/components/ui/badge";
import { DescriptionList } from "@/components/ui/card";
import { formatDuration, formatStatistic, formatUsd } from "@/lib/format";
import { MetricValue } from "./metric-value";
import { TokenMetrics } from "./token-metrics";
import { COST_FIELDS } from "./metric-labels";
import { ResourceDistributionPanel } from "./resource-distribution";
import { StatisticsTable } from "./statistics-table";

function MetricDisclosure({ title, description, children, expanded = false }: { title: string; description: string; children: ReactNode; expanded?: boolean }) {
  if (expanded) return <section className="min-w-0 space-y-2 border-t border-border pt-3"><h3 className="text-xs font-semibold">{title}</h3><p className="text-xs text-text-muted">{description}</p>{children}</section>;
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

type OperationRow = { label: string; value: OperationStatistics };

function OperationsTable({ label, caption, rows, emptyLabel = "暂无可用数据" }: { label: string; caption: string; rows: readonly OperationRow[]; emptyLabel?: string }) {
  return <div className="overflow-hidden rounded-lg border border-border">
    <Table aria-label={label} className="text-[13px]">
      <TableCaption className="m-0 border-t border-border px-4 py-2 text-left text-xs">{caption}</TableCaption>
      <TableHeader className="bg-surface-muted/60"><TableRow>
        {["指标", "次数", "成功", "失败", "取消", "进行中", "未知"].map((name, index) => <TableHead key={name} scope="col" className={index === 0 ? "px-4 text-xs" : "text-right text-xs"}>{name}</TableHead>)}
      </TableRow></TableHeader>
      <TableBody>{rows.length === 0 ? <TableRow><TableCell colSpan={7} className="px-4 py-6 text-center text-text-muted">{emptyLabel}</TableCell></TableRow> : rows.map(({ label: name, value }, index) => <TableRow key={`${name}-${index}`}>
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
  const operations = [
    { label: "处理轮（Turn）", value: trajectory.turns },
    { label: "思考命中轮", value: trajectory.thinkingTurnOperations },
    { label: "内容命中轮", value: trajectory.contentTurnOperations },
    { label: "模型请求", value: modelRequests },
    { label: "工具调用", value: trajectory.tools },
  ];
  return <section aria-label="操作次数" className="flex min-w-0 flex-col gap-4">
    <div><h3 className="text-sm font-semibold text-text-strong">操作次数</h3><p className="mt-1 text-xs text-text-muted">先看处理轮和子操作发生了多少次，再按工具查看具体结果。</p></div>
    <OperationsTable label="操作次数" caption="处理轮、模型请求和工具调用分别计数；思考和内容是处理轮的命中标记，状态列只适用于可追踪的操作。" rows={operations} />
    <div className="space-y-3"><div><h4 className="text-sm font-semibold text-text-strong">按工具查看</h4><p className="mt-1 text-xs text-text-muted">每种工具一行，查看调用次数和结果状态。</p></div>
      <OperationsTable label="工具调用明细" caption="每种工具的累计调用结果；未知不计为成功或失败。" rows={trajectory.byTool.map((tool) => ({ label: tool.toolName ?? "未识别工具", value: tool }))} emptyLabel="暂无工具调用" />
    </div>
    {(trajectory.unlinkedOperations.tools > 0 || trajectory.unlinkedOperations.generations > 0) && <p className="text-xs text-muted-foreground">
      未关联到处理轮的工具 {trajectory.unlinkedOperations.tools} 次、模型请求 {trajectory.unlinkedOperations.generations} 次，思考轮和内容轮统计可能不完整。
    </p>}
  </section>;
}

function CostMetrics({ statistics, compact }: { statistics: ResourceStatistics; compact: boolean }) {
  return <section aria-label="费用" className="min-w-0 rounded-xl border border-border bg-surface p-4 shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div><h3 className="text-sm font-semibold text-text-strong">费用</h3><p className="mt-1 text-xs text-text-muted">实际扣除与模型成本分别展示。</p></div>
      <span className="rounded-full bg-surface-muted px-2 py-1 text-[11px] text-text-muted">结算</span>
    </div>
    <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div className="rounded-lg bg-surface-muted/70 px-3 py-3"><dt className="text-xs text-text-muted">实际积分</dt><dd className="mt-1.5 text-xl font-semibold tabular-nums text-text-strong"><MetricValue metric={statistics.costs.chargedUnits} format={formatStatistic} /></dd></div>
      <div className="rounded-lg bg-surface-muted/70 px-3 py-3"><dt className="text-xs text-text-muted">模型成本 · USD</dt><dd className="mt-1.5 text-xl font-semibold tabular-nums text-text-strong"><MetricValue metric={statistics.costs.providerUsd} format={formatUsd} /></dd></div>
    </dl>
    <MetricDisclosure expanded={compact} title="费用明细" description="模型、Action、计价与实际扣除分别记录，不将这些字段重复相加。">
      <DescriptionList className="rounded-lg border border-border p-3" items={COST_FIELDS.filter(([key]) => key !== "chargedUnits" && key !== "providerUsd").map(([key, label]) => ({
        label, value: <MetricValue metric={statistics.costs[key]} format={formatStatistic} />,
      }))} />
    </MetricDisclosure>
  </section>;
}

function DurationMetrics({ statistics, durations }: { statistics: ResourceStatistics; durations?: Pick<StageStatistics, "agentDurationMs" | "attemptDurationMs"> }) {
  const operations = [
    { label: "处理轮（Turn）", unit: "毫秒", summary: statistics.trajectory.turns.durationMs, format: formatDuration },
    { label: "模型请求", unit: "毫秒", summary: statistics.modelRequests.durationMs, format: formatDuration },
    { label: "工具调用", unit: "毫秒", summary: statistics.trajectory.tools.durationMs, format: formatDuration },
  ];
  return <section aria-label="耗时明细" className="min-w-0 space-y-4">
    {durations && <StatisticsTable label="Agent 与尝试耗时" total description="Agent 耗时覆盖完整 Agent 生命周期；单次尝试耗时只覆盖一次运行尝试。" rows={[
      { label: "Agent 总耗时", unit: "毫秒", summary: durations.agentDurationMs, format: formatDuration },
      { label: "单次尝试耗时", unit: "毫秒", summary: durations.attemptDurationMs, format: formatDuration },
    ]} />}
    <StatisticsTable label="操作耗时" total description="处理轮、模型请求和工具调用分别统计单次操作耗时。" rows={operations} />
  </section>;
}

const PANEL_OPTIONS = [
  { value: "costs", label: "费用", description: "积分与模型成本", Icon: Coins },
  { value: "tokens", label: "Token", description: "Token 与缓存用量", Icon: Sigma },
  { value: "operations", label: "操作次数", description: "处理轮、请求和工具", Icon: ListChecks },
  { value: "durations", label: "耗时", description: "Agent、尝试和操作", Icon: Clock3 },
] as const;
type MetricPanel = (typeof PANEL_OPTIONS)[number]["value"];

function PanelSelector({ value, onChange }: { value: MetricPanel; onChange: (value: MetricPanel) => void }) {
  return <div role="tablist" aria-label="分项指标" className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-surface-muted/50 p-2 sm:grid-cols-4">
    {PANEL_OPTIONS.map((item) => {
      const selected = value === item.value;
      const Icon = item.Icon;
      return <button key={item.value} type="button" role="tab" aria-selected={selected} onClick={() => onChange(item.value)} className={`group relative min-h-[76px] min-w-0 rounded-lg border px-3 py-3 text-left transition-[background-color,border-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 ${selected ? "border-border-strong bg-surface shadow-sm" : "border-transparent bg-transparent hover:border-border hover:bg-surface"}`}>
        {selected && <span aria-hidden="true" className="absolute inset-y-3 left-0.5 w-0.5 rounded-full bg-primary" />}
        <span className="flex items-start gap-2.5">
          <span className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg ${selected ? "bg-surface-muted text-text-strong" : "bg-surface text-text-muted group-hover:text-text-strong"}`}><Icon aria-hidden="true" className="size-4" strokeWidth={1.8} /></span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-semibold text-text-strong">{item.label}</span>
              {selected && <Check aria-hidden="true" className="size-4 shrink-0 text-text-strong" strokeWidth={2.25} />}
            </span>
            <span className="mt-1 block text-xs leading-5 text-text-muted">{item.description}</span>
          </span>
        </span>
      </button>;
    })}
  </div>;
}

/** Resource details are organized by the thing being measured; Agent scope stays fixed at the current entry. */
export function ResourceMetrics({ statistics, distribution, durations, showCoverage = true, compact = false }: {
  statistics: ResourceStatistics; distribution?: ResourceDistribution;
  durations?: Pick<StageStatistics, "agentDurationMs" | "attemptDurationMs">;
  showCoverage?: boolean;
  compact?: boolean;
}) {
  const [panel, setPanel] = useState<MetricPanel>("operations");
  const activePanel = PANEL_OPTIONS.find((item) => item.value === panel)!;
  const content = panel === "costs" ? <div className="flex min-w-0 flex-col gap-5"><CostMetrics statistics={statistics} compact={compact} />{distribution && <ResourceDistributionPanel distribution={distribution} statistics={statistics} section="costs" />}</div>
    : panel === "tokens" ? <div className="flex min-w-0 flex-col gap-5"><TokenMetrics statistics={statistics} />{distribution && <ResourceDistributionPanel distribution={distribution} statistics={statistics} section="tokens" />}</div>
      : panel === "operations" ? <div className="flex min-w-0 flex-col gap-5">
        <TrajectoryMetrics trajectory={statistics.trajectory} modelRequests={statistics.modelRequests} />
        {distribution && <ResourceDistributionPanel distribution={distribution} statistics={statistics} section="operations" />}
      </div>
        : <DurationMetrics statistics={statistics} durations={durations} />;
  return <div className={compact ? "flex min-w-0 flex-col gap-3 [&_td]:px-2 [&_td]:py-1.5 [&_th]:px-2 [&_th]:py-1.5 [&_th]:h-8 [&_dd]:text-sm [&_dd]:mt-1 [&_dl]:gap-2 [&_dl]:p-2 [&_dl]:grid-cols-2 [&_table]:text-xs [&_td]:whitespace-nowrap" : "flex min-w-0 flex-col gap-5"}>
    <section aria-label="分项详细数据" className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h3 className="text-sm font-semibold text-text-strong">分项详细数据</h3><p className="mt-1 text-xs text-text-muted">按费用、Token、操作次数和耗时查看当前入口下全部 Agent 的明细。</p></div>
        {showCoverage && <dl className="flex shrink-0 items-center gap-2 text-xs"><dt className="text-text-muted">资源完整性</dt><dd><StatusBadge status={statistics.coverage} /></dd></dl>}
      </div>
      <PanelSelector value={panel} onChange={setPanel} />
      <div role="tabpanel" aria-label={`${activePanel.label}明细`} className="min-w-0 pt-2">{content}</div>
    </section>
    {statistics.diagnostics.length > 0 && <MetricDisclosure expanded={compact} title={`统计诊断（${statistics.diagnostics.length}）`} description="查看缺失来源、重复记录和其他统计诊断。">
      <ul className="list-inside list-disc text-xs leading-6 text-text-muted">{statistics.diagnostics.map((item, index) => <li key={index}>{item.stream} · {item.eventId ?? item.kind} · {item.message}</li>)}</ul>
    </MetricDisclosure>}
  </div>;
}
