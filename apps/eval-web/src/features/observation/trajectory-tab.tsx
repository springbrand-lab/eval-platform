import { Collapsible, CollapsibleContent, CollapsibleTrigger, NativeSelect, NativeSelectOption } from "@springbrand/site-block";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import type { ObservedKind, TrajectoryEvent } from "@/api-sdk/observations-api";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { JsonViewer } from "@/components/ui/data-display";
import { EmptyState, ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
import { formatDateTime } from "@/lib/format";
import { useTrajectory } from "./use-trajectory";

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
type EventCategory = keyof typeof CATEGORIES;

function category(event: TrajectoryEvent): EventCategory {
  const family = event.type.split(".")[0]!;
  return Object.hasOwn(CATEGORIES, family) ? family as EventCategory : "other";
}

/** One line of what happened: the tool, model or message the event is about. */
export function eventSummary(event: TrajectoryEvent): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]) => keys.map((key) => payload[key]).find((value) => typeof value === "string" && value) as string | undefined;
  const tool = pick("toolName");
  const model = pick("model");
  const text = pick("summary", "error", "reason");
  return [tool && `工具 ${tool}`, model && `模型 ${model}`, text && text.slice(0, 160)].filter(Boolean).join(" · ");
}

function EventRow({ seq, event }: { seq: number; event: TrajectoryEvent }) {
  const kind = CATEGORIES[category(event)];
  return (
    <li className="border-b border-border last:border-b-0">
      <Collapsible>
      <CollapsibleTrigger className="group flex w-full flex-wrap items-center gap-3 px-4 py-2 text-left text-[13px] hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight className="size-3.5 shrink-0 group-data-open:rotate-90" />
        <span className="w-12 shrink-0 font-mono text-xs text-text-muted">#{seq}</span>
        <span className="w-40 shrink-0 text-xs text-text-muted tabular">{formatDateTime(event.occurredAt)}</span>
        <Badge tone={event.payload?.outcome === "failed" || event.payload?.error ? "danger" : kind.tone}>{kind.label} · {event.type}</Badge>
        <span className="truncate text-text-muted">{eventSummary(event)}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-4 pb-3"><JsonViewer value={event} /></CollapsibleContent>
      </Collapsible>
    </li>
  );
}

export function TrajectoryTab({ projectId, kind, id, running = false }: { projectId: string; kind: ObservedKind; id: string; running?: boolean }) {
  const [filter, setFilter] = useState<EventCategory | "all">("all");
  const [tool, setTool] = useState("");
  const { query: pages, older } = useTrajectory({ projectId, kind, id, running });
  if (pages.isPending) return <LoadingBlock />;
  if (!pages.data) return <ErrorBlock error={pages.error} onRetry={() => void pages.refetch()} />;
  const events = pages.data.events;
  const tools = [...new Set(events.filter((item) => category(item.event) === "tool").map((item) => item.event.payload?.toolName).filter((name): name is string => typeof name === "string"))].sort();
  const visible = events.filter((item) => (filter === "all" || category(item.event) === filter) && (filter !== "tool" || !tool || item.event.payload?.toolName === tool));
  return (
    <div className="rounded-[var(--radius-card)] border border-border bg-surface">
      <fieldset className="flex flex-wrap items-end gap-3 border-b border-border p-3">
        <legend className="sr-only">轨迹筛选</legend>
        <label className="flex flex-col gap-1 text-sm">事件类别
          <NativeSelect value={filter} onChange={(event) => { setFilter(event.target.value as typeof filter); setTool(""); }}>
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
        : <ol>{visible.map((item) => <EventRow key={item.ingestSeq} seq={item.ingestSeq} event={item.event} />)}</ol>}
    </div>
  );
}
