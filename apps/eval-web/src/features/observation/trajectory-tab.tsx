import { Collapsible, CollapsibleContent, CollapsibleTrigger, NativeSelect, NativeSelectOption } from "@springbrand/site-block";
import { isSpPiTrajectoryReference, type SpPiTrajectoryPageRow } from "@eval-platform/eval-contracts";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import type { ObservedKind } from "@/api-sdk/observations-api";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { JsonViewer } from "@/components/ui/data-display";
import { EmptyState, ErrorBlock, LoadingBlock, Notice } from "@/components/ui/feedback";
import { useTrajectory } from "./use-trajectory";

const CATEGORIES = {
  conversation: { label: "会话", tone: "neutral" },
  entry: { label: "原生条目", tone: "info" },
  reference: { label: "大记录引用", tone: "warning" },
} as const satisfies Record<string, { label: string; tone: Tone }>;
type RecordCategory = keyof typeof CATEGORIES;

function category(row: SpPiTrajectoryPageRow): RecordCategory {
  return isSpPiTrajectoryReference(row) ? "reference" : row.record.record.type;
}

function entryKind(row: SpPiTrajectoryPageRow): string | null {
  return !isSpPiTrajectoryReference(row) && row.record.record.type === "entry" ? row.record.record.value.kind : null;
}

function RecordRow({ row }: { row: SpPiTrajectoryPageRow }) {
  const reference = isSpPiTrajectoryReference(row);
  const kind = CATEGORIES[category(row)];
  return (
    <li className="border-b border-border last:border-b-0">
      <Collapsible>
      <CollapsibleTrigger className="group flex w-full flex-wrap items-center gap-3 px-4 py-2 text-left text-[13px] hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight className="size-3.5 shrink-0 group-data-open:rotate-90" />
        <span className="w-12 shrink-0 font-mono text-xs text-text-muted">#{row.ingestSeq}</span>
        <span className="w-40 shrink-0 text-xs text-text-muted tabular">{reference ? "原文未内联" : `原生 ID ${row.record.record.value.id}`}</span>
        <Badge tone={kind.tone}>{kind.label}{entryKind(row) && ` · ${entryKind(row)}`}</Badge>
        <span className="min-w-0 truncate text-text-muted">{reference
          ? `${row.reference.byteLength.toLocaleString()} B · 当前接口仅有引用`
          : row.record.submissionId ? `Submission ${row.record.submissionId}` : "Context（无 Submission）"}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 px-4 pb-3">
        {reference && <Notice tone="warning">当前调试接口仅返回引用，无法在此读取完整原文；此行不是完整的 Pi 记录。</Notice>}
        <JsonViewer value={row} />
      </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

export function TrajectoryTab({ projectId, kind, id, running = false }: { projectId: string; kind: ObservedKind; id: string; running?: boolean }) {
  const [filter, setFilter] = useState<RecordCategory | "all">("all");
  const [selectedKind, setSelectedKind] = useState("");
  const { query: pages, more } = useTrajectory({ projectId, kind, id, running });
  if (pages.isPending) return <LoadingBlock />;
  if (!pages.data) return <ErrorBlock error={pages.error} onRetry={() => void pages.refetch()} />;
  const records = pages.data.records;
  const kinds = new Set<string>();
  for (const row of records) {
    const value = entryKind(row);
    if (value !== null) kinds.add(value);
  }
  const visible = records.filter((row) => (filter === "all" || category(row) === filter)
    && (filter !== "entry" || !selectedKind || entryKind(row) === selectedKind));
  return (
    <div className="rounded-[var(--radius-card)] border border-border bg-surface">
      <fieldset className="flex flex-wrap items-end gap-3 border-b border-border p-3">
        <legend className="sr-only">轨迹筛选</legend>
        <label className="flex flex-col gap-1 text-sm">记录类型
          <NativeSelect value={filter} onChange={(event) => { setFilter(event.target.value as typeof filter); setSelectedKind(""); }}>
            <NativeSelectOption value="all">全部记录</NativeSelectOption>
            {Object.entries(CATEGORIES).map(([value, item]) => <NativeSelectOption key={value} value={value}>{item.label}</NativeSelectOption>)}
          </NativeSelect>
        </label>
        {filter === "entry" && <label className="flex flex-col gap-1 text-sm">条目 kind
          <NativeSelect value={selectedKind} onChange={(event) => setSelectedKind(event.target.value)}>
            <NativeSelectOption value="">全部条目</NativeSelectOption>
            {[...kinds].sort().map((name) => <NativeSelectOption key={name} value={name}>{name}</NativeSelectOption>)}
          </NativeSelect>
        </label>}
        <p className="text-xs text-muted-foreground">已加载 {records.length} 条，显示 {visible.length} 条。筛选仅限已加载记录。</p>
      </fieldset>
      {pages.error && <ErrorBlock error={pages.error} onRetry={() => void pages.refetch()} />}
      {more.error && <ErrorBlock error={more.error} onRetry={() => more.mutate()} />}
      {pages.data.nextAfterSeq !== null && (
        <div className="border-b border-border p-2 text-center">
          <Button size="sm" variant="ghost" loading={more.isPending} onClick={() => more.mutate()}>加载更多记录</Button>
        </div>
      )}
      {visible.length === 0 ? <EmptyState title={records.length === 0 ? "还没有轨迹记录" : "已加载记录中没有匹配项"} />
        : <ol>{visible.map((row) => <RecordRow key={row.ingestSeq} row={row} />)}</ol>}
    </div>
  );
}
