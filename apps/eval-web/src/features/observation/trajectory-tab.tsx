import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { getTrajectoryPage, observationKeys, type ObservedKind, type TrajectoryEvent } from "@/api-sdk/observations-api";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { JsonViewer } from "@/components/ui/data-display";
import { EmptyState, ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
import { formatDateTime } from "@/lib/format";

function tone(type: string): Tone {
  if (type.startsWith("tool")) return "info";
  if (type.startsWith("generation") || type.startsWith("model")) return "primary";
  if (type.includes("error") || type.includes("failed")) return "danger";
  if (type.startsWith("approval") || type.startsWith("interaction")) return "warning";
  return "neutral";
}

/** One line of what happened: the tool, model or message the event is about. */
export function eventSummary(event: TrajectoryEvent): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]) => keys.map((key) => payload[key]).find((value) => typeof value === "string" && value) as string | undefined;
  const tool = pick("toolName", "name");
  const model = pick("model", "modelId");
  const text = pick("text", "message", "error", "reason");
  return [tool && `工具 ${tool}`, model && `模型 ${model}`, text && text.slice(0, 160)].filter(Boolean).join(" · ");
}

function EventRow({ seq, event }: { seq: number; event: TrajectoryEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-b border-border last:border-b-0">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 px-4 py-2 text-left text-[13px] hover:bg-surface-muted">
        {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        <span className="w-12 shrink-0 font-mono text-xs text-text-muted">#{seq}</span>
        <span className="w-40 shrink-0 text-xs text-text-muted tabular">{formatDateTime(event.occurredAt)}</span>
        <Badge tone={tone(event.type)}>{event.type}</Badge>
        <span className="truncate text-text-muted">{eventSummary(event)}</span>
      </button>
      {open && <div className="px-4 pb-3"><JsonViewer value={event} /></div>}
    </li>
  );
}

export function TrajectoryTab({ projectId, kind, id }: { projectId: string; kind: ObservedKind; id: string }) {
  const pages = useInfiniteQuery({
    queryKey: observationKeys.part(projectId, kind, id, "trajectory"),
    queryFn: ({ pageParam, signal }) => getTrajectoryPage(projectId, kind, id, pageParam, signal),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.hasOlder && last.beforeSeq ? last.beforeSeq : undefined),
  });
  if (pages.isPending) return <LoadingBlock />;
  if (pages.error) return <ErrorBlock error={pages.error} />;
  // Pages arrive newest first; show the timeline oldest first.
  const events = pages.data.pages.flatMap((page) => page.events).sort((left, right) => left.ingestSeq - right.ingestSeq);
  if (events.length === 0) return <EmptyState title="还没有轨迹事件" />;
  return (
    <div className="rounded-[var(--radius-card)] border border-border bg-surface">
      {pages.hasNextPage && (
        <div className="border-b border-border p-2 text-center">
          <Button size="sm" variant="ghost" loading={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>加载更早的事件</Button>
        </div>
      )}
      <ol>{events.map((item) => <EventRow key={item.ingestSeq} seq={item.ingestSeq} event={item.event} />)}</ol>
    </div>
  );
}
