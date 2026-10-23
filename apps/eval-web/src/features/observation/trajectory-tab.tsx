import { Collapsible, CollapsibleContent, CollapsibleTrigger, NativeSelect, NativeSelectOption } from "@springbrand/site-block";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { ObservedKind, TrajectoryEvent } from "@/api-sdk/observations-api";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { JsonViewer } from "@/components/ui/data-display";
import { EmptyState, ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
import { formatDateTime } from "@/lib/format";
import { useTrajectory } from "./use-trajectory";
import { describeTrajectoryRecord, readNativeRecordDetail, type TrajectoryCategory, type TrajectoryRecordDescription } from "@eval-platform/eval-runtime/harness";

const CATEGORIES = {
  turn: { label: "轮次", tone: "neutral" },
  generation: { label: "模型请求", tone: "accent" },
  tool: { label: "工具调用", tone: "info" },
  approval: { label: "审批", tone: "warning" },
  interaction: { label: "交互", tone: "warning" },
  subagent: { label: "子 Agent", tone: "info" },
  context: { label: "上下文", tone: "neutral" },
  other: { label: "其他事件", tone: "neutral" },
} as const satisfies Record<string, { label: string; tone: Tone }>;

function EventRow({ seq, event, description, source }: {
  seq: number; event: TrajectoryEvent; description: TrajectoryRecordDescription; source: readonly TrajectoryEvent[];
}) {
  const kind = CATEGORIES[description.category];
  const detail = useMutation({ mutationFn: () => readNativeRecordDetail(source, event) });
  return (
    <li className="border-b border-border last:border-b-0">
      <Collapsible onOpenChange={(open) => { if (open && detail.isIdle) detail.mutate(); }}>
      <CollapsibleTrigger className="group flex w-full flex-wrap items-center gap-3 px-4 py-2 text-left text-[13px] hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight className="size-3.5 shrink-0 group-data-open:rotate-90" />
        <span className="w-12 shrink-0 font-mono text-xs text-text-muted">#{seq}</span>
        <span className="w-40 shrink-0 text-xs text-text-muted tabular">{formatDateTime(description.occurredAt)}</span>
        <Badge tone={description.failed ? "danger" : kind.tone}>{kind.label} · {description.type}</Badge>
        <span className="truncate text-text-muted">{description.summary.slice(0, 160)}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-4 pb-3">
        <JsonViewer value={event} />
        {detail.isPending && <p role="status" className="text-xs text-text-muted">正在解析原生依赖</p>}
        {detail.error && <div role="status">
          <p className="text-xs text-text-muted">当前已加载轨迹不足以解析原生依赖。可加载更早的事件后重试，不会重建另一份上下文。</p>
          <Button size="sm" variant="ghost" onClick={() => detail.mutate()}>重试原生解析</Button>
        </div>}
        {detail.data !== undefined && <section aria-label="原生请求与会话上下文">
          <h4 className="text-sm">原生请求与会话上下文</h4>
          <p className="text-xs text-text-muted">Pi 标准会话上下文与安全变更用于审计，不是模型输入的完整快照。</p>
          <JsonViewer value={detail.data} />
        </section>}
      </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

export function TrajectoryTab({ projectId, kind, id, running = false }: { projectId: string; kind: ObservedKind; id: string; running?: boolean }) {
  const [filter, setFilter] = useState<TrajectoryCategory | "all">("all");
  const [tool, setTool] = useState("");
  const [model, setModel] = useState("");
  const { query: pages, older } = useTrajectory({ projectId, kind, id, running });
  if (pages.isPending) return <LoadingBlock />;
  if (!pages.data) return <ErrorBlock error={pages.error} onRetry={() => void pages.refetch()} />;
  const events = pages.data.events;
  const source = events.map((item) => item.event);
  const described = events.map((item) => ({ ...item, description: describeTrajectoryRecord(item.event, source) }));
  const tools = [...new Set(described.flatMap((item) => item.description.tools))].sort();
  const models = [...new Set(described.flatMap((item) => item.description.models))].sort();
  const visible = described.filter((item) => (filter === "all" || item.description.category === filter
    || filter === "tool" && item.description.tools.length > 0
    || filter === "generation" && item.description.models.length > 0)
    && (filter !== "tool" || !tool || item.description.tools.includes(tool))
    && (filter !== "generation" || !model || item.description.models.includes(model)));
  return (
    <div className="rounded-[var(--radius-card)] border border-border bg-surface">
      <fieldset className="flex flex-wrap items-end gap-3 border-b border-border p-3">
        <legend className="sr-only">轨迹筛选</legend>
        <label className="flex flex-col gap-1 text-sm">事件类别
          <NativeSelect value={filter} onChange={(event) => { setFilter(event.target.value as typeof filter); setTool(""); setModel(""); }}>
            <NativeSelectOption value="all">全部类别</NativeSelectOption>
            {Object.entries(CATEGORIES).map(([value, item]) => <NativeSelectOption key={value} value={value}>{item.label}</NativeSelectOption>)}
          </NativeSelect>
        </label>
        {filter === "tool" && <label className="flex flex-col gap-1 text-sm">工具类型
          <NativeSelect value={tool} onChange={(event) => setTool(event.target.value)}>
            <NativeSelectOption value="">全部工具</NativeSelectOption>
            {tools.map((name) => <NativeSelectOption key={name} value={name}>{name}</NativeSelectOption>)}
          </NativeSelect>
        </label>}
        {filter === "generation" && <label className="flex flex-col gap-1 text-sm">模型
          <NativeSelect value={model} onChange={(event) => setModel(event.target.value)}>
            <NativeSelectOption value="">全部模型</NativeSelectOption>
            {models.map((name) => <NativeSelectOption key={name} value={name}>{name}</NativeSelectOption>)}
          </NativeSelect>
        </label>}
        <p className="text-xs text-muted-foreground">已加载 {events.length} 条，显示 {visible.length} 条。筛选仅限已加载事件。</p>
      </fieldset>
      {pages.error && <ErrorBlock error={pages.error} onRetry={() => void pages.refetch()} />}
      {older.error && <ErrorBlock error={older.error} onRetry={() => older.mutate()} />}
      {pages.data.hasOlder && (
        <div className="border-b border-border p-2 text-center">
          <Button size="sm" variant="ghost" loading={older.isPending} onClick={() => older.mutate()}>加载更早的事件</Button>
        </div>
      )}
      {visible.length === 0 ? <EmptyState title={events.length === 0 ? "还没有轨迹事件" : "已加载事件中没有匹配项"} />
        : <ol>{visible.map((item) => <EventRow key={item.ingestSeq} seq={item.ingestSeq} event={item.event} description={item.description} source={source} />)}</ol>}
    </div>
  );
}
