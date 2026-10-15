import { AlertTriangle, Inbox, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded bg-surface-muted", className)} aria-hidden />;
}

export function LoadingBlock({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3 p-4" role="status" aria-label="加载中">
      {Array.from({ length: rows }, (_, index) => <Skeleton key={index} className="h-5 w-full" />)}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("size-4 animate-spin text-text-muted", className)} aria-label="加载中" />;
}

export function EmptyState({ title, description, action, icon }: {
  title: ReactNode; description?: ReactNode; action?: ReactNode; icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <div className="text-text-muted">{icon ?? <Inbox className="size-8" />}</div>
      <p className="text-sm font-medium text-text">{title}</p>
      {description && <p className="max-w-md text-sm text-text-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorBlock({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-danger/30 bg-danger-soft p-4 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
      <div className="flex-1">
        <p className="font-medium text-danger">加载失败</p>
        <p className="mt-1 text-text">{describeError(error)}</p>
      </div>
      {onRetry && (
        <button type="button" onClick={onRetry} className="text-sm font-medium text-primary hover:underline">重试</button>
      )}
    </div>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warning" | "danger"; children: ReactNode }) {
  const styles = {
    info: "border-info/30 bg-info-soft",
    warning: "border-warning/30 bg-warning-soft",
    danger: "border-danger/30 bg-danger-soft",
  };
  return <div className={cn("rounded-[var(--radius-card)] border px-4 py-3 text-sm text-text", styles[tone])}>{children}</div>;
}
