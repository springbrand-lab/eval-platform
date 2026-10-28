import {
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type OnChangeFn,
  type RowSelectionState,
  type SortingState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ArrowUpDown, Search } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, Checkbox, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@springbrand/site-block";
import { cn } from "@/lib/cn";
import { EmptyState } from "./feedback";
import { TablePagination, useTablePagination, type TablePageControl } from "./pagination";

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Present: the column sorts by this value. */
  sortValue?: (row: T) => string | number | null | undefined;
  className?: string;
  align?: "left" | "right";
}

export interface TableSortingControl {
  value: SortingState;
  onChange: OnChangeFn<SortingState>;
}

export interface DataTableProps<T> {
  rows: readonly T[];
  columns: readonly Column<T>[];
  rowKey: (row: T) => string;
  rowLabel?: (row: T) => string;
  /** Present: a search box filters rows by this text. */
  searchText?: (row: T) => string;
  searchPlaceholder?: string;
  searchValue?: string;
  onSearchChange?: (query: string) => void;
  pagination?: TablePageControl;
  sorting?: TableSortingControl;
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
  rows, columns, rowKey, rowLabel, searchText, searchPlaceholder = "搜索", onRowClick, empty, toolbar,
  selectable, selected, onSelectedChange, searchValue, onSearchChange, pagination: pageControl, sorting: sortControl,
}: DataTableProps<T>) {
  const [localSorting, setLocalSorting] = useState<SortingState>([]);
  const sorting = sortControl?.value ?? localSorting;
  const [localQuery, setLocalQuery] = useState("");
  const query = searchValue ?? localQuery;
  const changeQuery = (next: string) => {
    if (onSearchChange) onSearchChange(next);
    else setLocalQuery(next);
  };
  const columnsByKey = new Map(columns.map((column) => [column.key, column]));
  const rowSelection = useMemo<RowSelectionState>(
    () => Object.fromEntries([...(selected ?? [])].map((key) => [key, true])), [selected],
  );

  const definitions = useMemo<ColumnDef<T>[]>(() => {
    const defs: ColumnDef<T>[] = columns.map((column) => ({
      id: column.key,
      enableSorting: !!column.sortValue,
      sortDescFirst: false,
      ...(column.sortValue ? { accessorFn: (row: T) => column.sortValue!(row) ?? "", sortUndefined: "last" as const } : {}),
      meta: { className: column.className, align: column.align },
    }));
    if (selectable) {
      defs.unshift({
        id: "__select",
        enableSorting: false,
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
    onSortingChange: (next) => {
      if (sortControl) sortControl.onChange(next);
      else { setLocalSorting(next); pageControl?.onPageChange(0); }
    },
    onGlobalFilterChange: changeQuery,
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

  const filtered = table.getRowModel().rows;
  const pagination = useTablePagination(filtered, JSON.stringify([query, sorting, rows.map(rowKey)]), pageControl);
  const visible = pagination.items;
  const selectedOnPage = visible.filter((row) => row.getIsSelected()).length;
  const allOnPageSelected = visible.length > 0 && selectedOnPage === visible.length;
  const scroller = useRef<HTMLElement>(null);
  // Dune owns the single table viewport; virtualization and sticky headers use that same public slot.
  const connectViewport = useCallback((table: HTMLTableElement | null) => {
    scroller.current = table?.closest<HTMLElement>('[data-slot="table-container"]') ?? null;
  }, []);
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
    <div className="flex min-w-0 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
          {searchText && (
            <div className="relative w-full sm:w-72">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-text-faint" />
              <Input
                value={query}
                onChange={(event) => changeQuery(event.target.value)}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className="h-9 w-full rounded-[var(--radius-control)] border border-input bg-surface pl-8 pr-2 text-sm text-text-strong placeholder:text-text-faint focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
              />
            </div>
          )}
          <span role="status" className="text-xs tabular text-text-muted">{query.trim() ? `${filtered.length} / ${rows.length}` : rows.length} 条记录</span>
          <div className="ml-auto flex flex-wrap items-center gap-2">{toolbar}</div>
      </div>
      {visible.length === 0 ? (
        query.trim()
          ? <EmptyState title="没有匹配的结果" description="试试其他关键词，或清空搜索查看全部记录。"
            action={<Button type="button" variant="outline" onClick={() => changeQuery("")}>清空搜索</Button>} />
          : empty ?? <EmptyState title="暂无数据" />
      ) : (
        <div className={virtual ? "[&>[data-slot=table-container]]:max-h-[70vh] [&>[data-slot=table-container]]:overflow-y-auto" : undefined}>
          <Table ref={connectViewport} className="w-full border-collapse text-sm">
            <TableHeader className={cn("bg-surface-muted/60", virtual && "sticky top-0 z-10 bg-surface-muted")}>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id} className="border-b border-border text-left text-xs text-text-muted">
                  {group.headers.map((header) => {
                    const meta = header.column.columnDef.meta as { className?: string; align?: string } | undefined;
                    const sorted = header.column.getIsSorted();
                    return (
                      <TableHead key={header.id} aria-sort={sorted ? (sorted === "asc" ? "ascending" : "descending") : undefined}
                        className={cn("h-10 whitespace-nowrap px-4 font-medium", meta?.align === "right" && "text-right", meta?.className)}>
                        {header.column.id === "__select" ? <Checkbox aria-label="全选" title="全选当前页" checked={allOnPageSelected}
                          indeterminate={!allOnPageSelected && selectedOnPage > 0} onCheckedChange={(value) => {
                            const next = { ...rowSelection };
                            for (const row of visible) { if (value) next[row.id] = true; else delete next[row.id]; }
                            table.setRowSelection(next);
                          }} /> : header.column.getCanSort() ? (
                          <Button type="button" variant="ghost" size="sm" onClick={header.column.getToggleSortingHandler()}
                            className={cn("inline-flex h-auto items-center gap-1 px-0 py-1 text-xs font-medium hover:text-text-strong", meta?.align === "right" && "flex-row-reverse")}>
                            {columnsByKey.get(header.column.id)!.header}
                            {sorted === "asc" ? <ArrowUp className="size-3" /> : sorted === "desc" ? <ArrowDown className="size-3" /> : <ArrowUpDown className="size-3 opacity-40" />}
                          </Button>
                        ) : columnsByKey.get(header.column.id)!.header}
                      </TableHead>
                    );
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {padTop > 0 && <TableRow style={{ height: padTop }}><TableCell colSpan={columnCount} /></TableRow>}
              {shownRows.map((row, index) => (
                <TableRow
                  key={row.id}
                  data-index={virtual ? items[index]?.index : undefined}
                  ref={virtual ? virtualizer.measureElement : undefined}
                  data-state={row.getIsSelected() ? "selected" : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={onRowClick ? (event) => {
                    if (event.defaultPrevented || (event.target instanceof Element
                      && event.target.closest("a, button, input, select, textarea, [role=button], [role=checkbox], [role=switch]"))) return;
                    onRowClick(row.original);
                  } : undefined}
                  onKeyDown={onRowClick ? (event) => {
                    if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                      event.preventDefault();
                      onRowClick(row.original);
                    }
                  } : undefined}
                  className={cn(
                    "border-b border-border text-text last:border-b-0 data-[state=selected]:bg-surface-muted",
                    onRowClick && "cursor-pointer hover:bg-surface-hover focus-visible:bg-surface-muted focus-visible:outline-offset-[-2px]",
                  )}
                >
                  {row.getVisibleCells().map((cell) => {
                    const meta = cell.column.columnDef.meta as { className?: string; align?: string } | undefined;
                    return (
                      <TableCell key={cell.id} onClick={cell.column.id === "__select" ? (event) => event.stopPropagation() : undefined}
                        className={cn("h-11 px-4 py-2 align-middle", meta?.align === "right" && "text-right tabular", meta?.className)}>
                        {cell.column.id === "__select" ? <Checkbox aria-label={`选择 ${rowLabel?.(row.original) ?? rowKey(row.original)}`} checked={row.getIsSelected()} onCheckedChange={(value) => row.toggleSelected(value)} />
                          : columnsByKey.get(cell.column.id)!.cell(row.original)}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
              {padBottom > 0 && <TableRow style={{ height: padBottom }}><TableCell colSpan={columnCount} /></TableRow>}
            </TableBody>
          </Table>
        </div>
      )}
      <TablePagination {...pagination} />
    </div>
  );
}
