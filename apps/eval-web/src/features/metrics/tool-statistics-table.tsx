import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@springbrand/site-block";
import type { ResourceStatistics } from "@/api-sdk/types";
import { TablePagination, useTablePagination } from "@/components/ui/pagination";
import { formatDuration, formatMetricBytes } from "@/lib/format";
import { MetricValue } from "./metric-value";

type ToolMetric = ResourceStatistics["trajectory"]["byTool"][number];
type TableVariant = "operations" | "overview";

const toolName = (tool: ToolMetric): string => tool.toolName ?? "未识别工具";

/** The one tool table used by both the overview and the detailed operation view. */
export function ToolStatisticsTable({
  tools,
  variant,
  label = variant === "overview" ? "工具调用概况" : "工具调用明细",
  caption = variant === "overview" ? "未获得的长度或耗时不按零计数。" : "每种工具的累计调用结果；未知不计为成功或失败。",
  emptyLabel = "暂无工具调用",
}: {
  tools: readonly ToolMetric[];
  variant: TableVariant;
  label?: string;
  caption?: string;
  emptyLabel?: string;
}) {
  const overview = variant === "overview";
  const pagination = useTablePagination(tools, label);
  return <div className="overflow-hidden rounded-lg border border-border">
    <div className="overflow-x-auto">
      <Table aria-label={label} className={overview ? "min-w-[760px] text-[13px]" : "text-[13px]"}>
        <TableCaption className="m-0 border-t border-border px-3 py-2 text-left text-xs">{caption}</TableCaption>
        <TableHeader className="bg-surface-muted/60"><TableRow>
          {(overview
            ? ["工具", "调用次数", "成功", "失败", "平均耗时", "平均调用长度", "平均返回长度"]
            : ["工具", "调用次数", "成功", "失败", "取消", "进行中", "未知"]
          ).map((name, index) => <TableHead key={name} className={index === 0 ? "px-3 text-xs" : "text-right text-xs"}>{name}</TableHead>)}
        </TableRow></TableHeader>
        <TableBody>{tools.length === 0 ? <TableRow><TableCell colSpan={7} className="px-3 py-5 text-center text-text-muted">{emptyLabel}</TableCell></TableRow> : pagination.items.map((tool, index) => overview ? <TableRow key={`${tool.toolName ?? "unknown"}-${index}`}>
          <TableHead scope="row" className="px-3 font-medium text-text-strong">{toolName(tool)}</TableHead>
          <TableCell className="text-right font-semibold tabular-nums"><MetricValue metric={tool.count} /></TableCell>
          <TableCell className="text-right tabular-nums">{tool.completed}</TableCell>
          <TableCell className={`text-right tabular-nums ${tool.failed > 0 ? "font-medium text-danger" : "text-text-muted"}`}>{tool.failed}</TableCell>
          <TableCell className="text-right tabular-nums">{formatDuration(tool.durationMs.mean)}</TableCell>
          <TableCell className="text-right tabular-nums">{formatMetricBytes(tool.inputLength.mean)}</TableCell>
          <TableCell className="pr-3 text-right tabular-nums">{formatMetricBytes(tool.outputLength.mean)}</TableCell>
        </TableRow> : <TableRow key={`${tool.toolName ?? "unknown"}-${index}`}>
          <TableHead scope="row" className="max-w-64 whitespace-normal break-words px-3 py-3 font-medium text-text-strong">{toolName(tool)}</TableHead>
          <TableCell className="text-right font-semibold tabular-nums"><MetricValue metric={tool.count} /></TableCell>
          <TableCell className="text-right tabular-nums">{tool.completed}</TableCell>
          <TableCell className={`text-right tabular-nums ${tool.failed > 0 ? "font-medium text-danger" : "text-text-muted"}`}>{tool.failed}</TableCell>
          <TableCell className="text-right tabular-nums text-text-muted">{tool.cancelled}</TableCell>
          <TableCell className="text-right tabular-nums">{tool.inProgress}</TableCell>
          <TableCell className="pr-3 text-right tabular-nums text-text-muted">{tool.unknown}</TableCell>
        </TableRow>)}</TableBody>
      </Table>
    </div>
    <TablePagination {...pagination} label={`${label}分页`} />
  </div>;
}
