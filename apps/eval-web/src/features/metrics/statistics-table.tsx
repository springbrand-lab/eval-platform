import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@springbrand/site-block";
import type { NumericSummary } from "@/api-sdk/types";
import { formatNumber, formatStatistic, standardDeviation } from "@/lib/format";

export interface StatisticsRow {
  label: string;
  unit: string;
  summary: NumericSummary;
  format?: (value: number) => string;
}

export function StatisticsTable({ label, description, rows, total = false, showHeader = true }: {
  label: string; description: string; rows: readonly StatisticsRow[]; total?: boolean; showHeader?: boolean;
}) {
  return <section aria-label={label} className="min-w-0">
    {showHeader && <div className="mb-3">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-text-strong">{label}</h3>
        <p className="mt-1 text-xs leading-5 text-text-muted">{description}</p>
      </div>
    </div>}
    <div className="overflow-hidden rounded-lg border border-border">
      <Table aria-label={label} className="text-[13px]">
        <TableCaption className="m-0 border-t border-border px-4 py-2 text-left text-xs">
          均值、标准差和中位数只统计有效 N；缺失不补零。
        </TableCaption>
        <TableHeader className="bg-surface-muted/60"><TableRow>
          <TableHead scope="col" className="px-4 text-xs">指标 / 基础单位</TableHead>
          {total && <TableHead scope="col" className="text-right text-xs">累计</TableHead>}
          <TableHead scope="col" className="text-right text-xs">均值</TableHead>
          <TableHead scope="col" className="text-right text-xs">中位数</TableHead>
          <TableHead scope="col" className="text-right text-xs">最小 — 最大</TableHead>
          <TableHead scope="col" className="text-right text-xs">标准差</TableHead>
          <TableHead scope="col" className="text-right text-xs">有效 N</TableHead>
          <TableHead scope="col" className="pr-4 text-right text-xs">缺失</TableHead>
        </TableRow></TableHeader>
        <TableBody>{rows.map(({ label: name, unit, summary, format = formatStatistic }, index) => {
          const show = (value: number | null) => value === null ? "未获得" : format(value);
          return <TableRow key={`${name}-${index}`}>
            <TableHead scope="row" className="max-w-64 whitespace-normal px-4 py-3">
              <span className="block break-words font-medium text-text-strong">{name}</span>
              <span className="mt-0.5 block text-xs font-normal text-text-muted">{unit}</span>
            </TableHead>
            {total && <TableCell className="text-right tabular-nums text-text-secondary">{show(summary.total)}</TableCell>}
            <TableCell className="text-right font-semibold tabular-nums text-text-strong">{show(summary.mean)}</TableCell>
            <TableCell className="text-right tabular-nums">{show(summary.median)}</TableCell>
            <TableCell className="text-right tabular-nums text-text-secondary">
              <span aria-label={`最小 ${show(summary.min)}，最大 ${show(summary.max)}`}>{show(summary.min)} — {show(summary.max)}</span>
            </TableCell>
            <TableCell className="text-right tabular-nums">{show(standardDeviation(summary.variance) ?? null)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatNumber(summary.count)}</TableCell>
            <TableCell className={`pr-4 text-right tabular-nums ${summary.missing > 0 ? "text-warning" : "text-text-muted"}`}>{formatNumber(summary.missing)}</TableCell>
          </TableRow>;
        })}</TableBody>
      </Table>
    </div>
  </section>;
}
