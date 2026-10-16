import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type RowSelectionState,
  type SortingState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ArrowUpDown, Search } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { EmptyState } from "./feedback";
import { Checkbox } from "./form";

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
}

/** Rows above this count render through a virtualized, height-bounded body. */
const VIRTUAL_FROM = 100;
const ROW_HEIGHT = 44;

/** TanStack Table with local sorting, search and selection; long lists are virtualized with TanStack Virtual. */
export function DataTable<T>({
  rows, columns, rowKey, searchText, searchPlaceholder = "搜索", onRowClick, empty, toolbar,
  selectable, selected, onSelectedChange,
}: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [query, setQuery] = useState("");
  const rowSelection = useMemo<RowSelectionState>(
    () => Object.fromEntries([...(selected ?? [])].map((key) => [key, true])), [selected],
  );

  const definitions = useMemo<ColumnDef<T>[]>(() => {
    const defs: ColumnDef<T>[] = columns.map((column) => ({
      id: column.key,
      header: () => column.header,
      cell: ({ row }) => column.cell(row.original),
      enableSorting: !!column.sortValue,
      sortDescFirst: false,
      ...(column.sortValue ? { accessorFn: (row: T) => column.sortValue!(row) ?? "", sortUndefined: "last" as const } : {}),
      meta: { className: column.className, align: column.align },
    }));
    if (selectable) {
      defs.unshift({
        id: "__select",
        header: ({ table }) => (
          <Checkbox aria-label="全选"
            checked={table.getIsAllRowsSelected() ? true : table.getIsSomeRowsSelected() ? "indeterminate" : false}
            onCheckedChange={(value) => table.toggleAllRowsSelected(value)} />
        ),
        cell: ({ row }) => <Checkbox aria-label="选择" checked={row.getIsSelected()} onCheckedChange={(value) => row.toggleSelected(value)} />,
        meta: { className: "w-10" },
      });
    }
    return defs;
  }, [columns, selectable]);

  const table = useReactTable({
    data: rows as T[],
    columns: definitions,
    getRowId: (row) => rowKey(row),
    state: { sorting, globalFilter: query, rowSelection },
    onSortingChange: setSorting,
    onGlobalFilterChange: setQuery,
    globalFilterFn: (row, _columnId, value: string) =>
      !searchText || searchText(row.original).toLowerCase().includes(value.trim().toLowerCase()),
    enableRowSelection: !!selectable,
    onRowSelectionChange: (updater) => {
      const next = typeof updater === "function" ? updater(rowSelection) : updater;
      onSelectedChange?.(new Set(Object.keys(next).filter((key) => next[key])));
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const visible = table.getRowModel().rows;
  const scroller = useRef<HTMLDivElement>(null);
  const virtual = visible.length > VIRTUAL_FROM;
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    enabled: virtual,
  });
  const items = virtual ? virtualizer.getVirtualItems() : [];
  const padTop = virtual && items.length > 0 ? items[0]!.start : 0;
  const padBottom = virtual && items.length > 0 ? virtualizer.getTotalSize() - items[items.length - 1]!.end : 0;
  const shownRows = virtual ? items.map((item) => visible[item.index]!) : visible;
  const columnCount = table.getVisibleLeafColumns().length;

  return (
    <div className="flex flex-col">
      {(searchText || toolbar) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          {searchText && (
            <div className="relative w-64">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-text-faint" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className="h-8 w-full rounded-[var(--radius-control)] border border-input bg-surface pl-8 pr-2 text-[13px] text-text-strong placeholder:text-text-faint focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
              />
            </div>
          )}
          <div className="ml-auto flex items-center gap-2">{toolbar}</div>
        </div>
      )}
      {visible.length === 0 ? (
        empty ?? <EmptyState title={query ? "没有匹配的结果" : "暂无数据"} />
      ) : (
        <div ref={scroller} className={cn("overflow-x-auto", virtual && "max-h-[70vh] overflow-y-auto")}>
          <table className="w-full border-collapse text-[13px]">
            <thead className={cn(virtual && "sticky top-0 z-10 bg-surface")}>
              {table.getHeaderGroups().map((group) => (
                <tr key={group.id} className="border-b border-border text-left text-xs text-text-muted">
                  {group.headers.map((header) => {
                    const meta = header.column.columnDef.meta as { className?: string; align?: string } | undefined;
                    const sorted = header.column.getIsSorted();
                    return (
                      <th key={header.id} className={cn("h-9 whitespace-nowrap px-3 font-semibold", meta?.align === "right" && "text-right", meta?.className)}>
                        {header.column.getCanSort() ? (
                          <button type="button" onClick={header.column.getToggleSortingHandler()}
                            className={cn("inline-flex items-center gap-1 hover:text-text-strong", meta?.align === "right" && "flex-row-reverse")}>
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {sorted === "asc" ? <ArrowUp className="size-3" /> : sorted === "desc" ? <ArrowDown className="size-3" /> : <ArrowUpDown className="size-3 opacity-40" />}
                          </button>
                        ) : flexRender(header.column.columnDef.header, header.getContext())}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {padTop > 0 && <tr style={{ height: padTop }}><td colSpan={columnCount} /></tr>}
              {shownRows.map((row) => (
                <tr
                  key={row.id}
                  data-state={row.getIsSelected() ? "selected" : undefined}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                  className={cn(
                    "border-b border-border text-text last:border-b-0 data-[state=selected]:bg-surface-muted",
                    onRowClick && "cursor-pointer hover:bg-surface-hover",
                  )}
                >
                  {row.getVisibleCells().map((cell) => {
                    const meta = cell.column.columnDef.meta as { className?: string; align?: string } | undefined;
                    return (
                      <td key={cell.id} onClick={cell.column.id === "__select" ? (event) => event.stopPropagation() : undefined}
                        className={cn("h-11 px-3 py-2 align-middle", meta?.align === "right" && "text-right tabular", meta?.className)}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {padBottom > 0 && <tr style={{ height: padBottom }}><td colSpan={columnCount} /></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
