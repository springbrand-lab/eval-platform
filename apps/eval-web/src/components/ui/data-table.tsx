import { ArrowDown, ArrowUp, Search } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { EmptyState } from "./feedback";

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Present: the column sorts by this value. */
  sortValue?: (row: T) => string | number | null | undefined;
  className?: string;
  align?: "left" | "right";
}

export interface DataTableProps<T> {
  rows: readonly T[];
  columns: readonly Column<T>[];
  rowKey: (row: T) => string;
  /** Present: a search box filters rows by this text. */
  searchText?: (row: T) => string;
  searchPlaceholder?: string;
  onRowClick?: (row: T) => void;
  empty?: ReactNode;
  toolbar?: ReactNode;
  selectable?: boolean;
  selected?: ReadonlySet<string>;
  onSelectedChange?: (next: Set<string>) => void;
  /** Rows rendered at most at once; the rest load on "show more". */
  pageSize?: number;
}

export function DataTable<T>({
  rows, columns, rowKey, searchText, searchPlaceholder = "搜索", onRowClick, empty, toolbar,
  selectable, selected, onSelectedChange, pageSize = 200,
}: DataTableProps<T>) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: string; desc: boolean } | null>(null);
  const [limit, setLimit] = useState(pageSize);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    let result = needle && searchText ? rows.filter((row) => searchText(row).toLowerCase().includes(needle)) : [...rows];
    const column = sort && columns.find((item) => item.key === sort.key);
    if (sort && column?.sortValue) {
      const value = column.sortValue;
      result = result.sort((left, right) => {
        const a = value(left) ?? "";
        const b = value(right) ?? "";
        const order = a < b ? -1 : a > b ? 1 : 0;
        return sort.desc ? -order : order;
      });
    }
    return result;
  }, [rows, query, sort, columns, searchText]);

  const shown = visible.slice(0, limit);
  const allSelected = selectable && shown.length > 0 && shown.every((row) => selected?.has(rowKey(row)));
  const toggleAll = () => {
    const next = new Set(selected);
    for (const row of shown) {
      if (allSelected) next.delete(rowKey(row));
      else next.add(rowKey(row));
    }
    onSelectedChange?.(next);
  };
  const toggle = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onSelectedChange?.(next);
  };

  return (
    <div className="flex flex-col">
      {(searchText || toolbar) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          {searchText && (
            <div className="relative w-64">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-muted" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className="h-8 w-full rounded-[var(--radius-control)] border border-input bg-surface pl-8 pr-2 text-[13px] text-text-strong placeholder:text-text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
              />
            </div>
          )}
          <div className="ml-auto flex items-center gap-2">{toolbar}</div>
        </div>
      )}
      {visible.length === 0 ? (
        empty ?? <EmptyState title={query ? "没有匹配的结果" : "暂无数据"} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-border text-left text-xs text-text-muted">
                {selectable && (
                  <th className="w-10 px-3 py-2">
                    <input type="checkbox" aria-label="全选" checked={!!allSelected} onChange={toggleAll} className="cursor-pointer accent-[var(--primary)]" />
                  </th>
                )}
                {columns.map((column) => (
                  <th key={column.key} className={cn("h-9 whitespace-nowrap px-3 font-semibold", column.align === "right" && "text-right", column.className)}>
                    {column.sortValue ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 hover:text-text-strong"
                        onClick={() => setSort((current) => current?.key === column.key
                          ? { key: column.key, desc: !current.desc } : { key: column.key, desc: false })}
                      >
                        {column.header}
                        {sort?.key === column.key && (sort.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                      </button>
                    ) : column.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => {
                const key = rowKey(row);
                return (
                  <tr
                    key={key}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    className={cn("border-b border-border text-text last:border-b-0", onRowClick && "cursor-pointer hover:bg-surface-hover")}
                  >
                    {selectable && (
                      <td className="px-3 py-2" onClick={(event) => event.stopPropagation()}>
                        <input type="checkbox" aria-label="选择" checked={selected?.has(key) ?? false} onChange={() => toggle(key)} className="cursor-pointer accent-[var(--primary)]" />
                      </td>
                    )}
                    {columns.map((column) => (
                      <td key={column.key} className={cn("h-11 px-3 py-2 align-middle", column.align === "right" && "text-right tabular", column.className)}>
                        {column.cell(row)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {visible.length > shown.length && (
            <div className="flex items-center justify-center gap-3 border-t border-border py-3 text-[13px] text-text-muted">
              已显示 {shown.length} / {visible.length}
              <button type="button" className="font-semibold text-link hover:underline" onClick={() => setLimit((value) => value + pageSize)}>
                显示更多
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
