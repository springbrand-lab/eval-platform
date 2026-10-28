import { useState } from "react";
import { formatNumber } from "@/lib/format";
import { Button } from "./button";

export const TABLE_PAGE_SIZE = 20;

export function useTablePagination<T>(rows: readonly T[], resetKey = "") {
  const pageCount = Math.max(1, Math.ceil(rows.length / TABLE_PAGE_SIZE));
  const [state, setState] = useState({ key: resetKey, pageIndex: 0 });
  const pageIndex = state.key === resetKey ? Math.min(state.pageIndex, pageCount - 1) : 0;
  if (state.key !== resetKey || state.pageIndex !== pageIndex) setState({ key: resetKey, pageIndex });
  return {
    items: rows.slice(pageIndex * TABLE_PAGE_SIZE, (pageIndex + 1) * TABLE_PAGE_SIZE),
    pageIndex, pageCount, total: rows.length,
    onPageChange: (next: number) => setState({ key: resetKey, pageIndex: Math.max(0, Math.min(next, pageCount - 1)) }),
  };
}

export interface TablePaginationProps {
  pageIndex: number;
  pageCount?: number;
  total?: number;
  hasNextPage?: boolean;
  disabled?: boolean;
  label?: string;
  onPageChange: (pageIndex: number) => void;
}

export function TablePagination({
  pageIndex, pageCount, total, hasNextPage, disabled = false, label = "表格分页", onPageChange,
}: TablePaginationProps) {
  const next = hasNextPage ?? pageIndex + 1 < (pageCount ?? 1);
  return <nav aria-label={label} className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-text-muted">
    <span className="whitespace-nowrap">{total !== undefined && `共 ${formatNumber(total)} 条 · `}每页 {TABLE_PAGE_SIZE} 条</span>
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" disabled={disabled || pageIndex === 0} onClick={() => onPageChange(pageIndex - 1)}>上一页</Button>
      <span aria-live="polite" className="whitespace-nowrap tabular-nums">第 {pageIndex + 1} 页{pageCount !== undefined && ` / 共 ${formatNumber(pageCount)} 页`}</span>
      <Button size="sm" disabled={disabled || !next} onClick={() => onPageChange(pageIndex + 1)}>下一页</Button>
    </div>
  </nav>;
}
