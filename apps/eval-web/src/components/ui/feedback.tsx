import { AlertTriangle, Inbox, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { ApiError } from "@springbrand/http/client";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-surface-muted", className)} aria-hidden />;
}

export function LoadingBlock({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2.5 p-4" role="status" aria-label="加载中">
      {Array.from({ length: rows }, (_, index) => <Skeleton key={index} className={cn("h-4", index % 3 === 2 ? "w-2/3" : "w-full")} />)}
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
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-surface-muted text-text-muted [&_svg]:size-5">
        {icon ?? <Inbox />}
      </div>
      <p className="text-sm font-semibold text-text-strong">{title}</p>
      {description && <p className="max-w-md text-[13px] leading-relaxed text-text-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorBlock({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-danger/30 bg-danger-soft p-4 text-[13px]">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
      <div className="flex-1">
        <p className="font-semibold text-danger">请求失败</p>
        <p className="mt-1 text-text">{describeError(error)}</p>
        {error instanceof ApiError && error.errors && error.errors.length > 0 && <ul className="mt-2 space-y-1">
          {error.errors.map((item, index) => <li key={index}><code>{item.path || "内容"}</code>：{item.errMsg}</li>)}
        </ul>}
      </div>
      {onRetry && <button type="button" onClick={onRetry} className=" link font-semibold">重试</button>}
    </div>
  );
}

export function Notice({ tone = "info", children, icon }: { tone?: "info" | "warning" | "danger" | "neutral"; children: ReactNode; icon?: ReactNode }) {
  const styles = {
    info: "border-info/20 bg-info-soft",
    warning: "border-warning/25 bg-warning-soft",
    danger: "border-danger/25 bg-danger-soft",
    neutral: "border-border bg-surface-muted",
  };
  return (
    <div className={cn("flex items-start gap-2.5 rounded-[var(--radius-card)] border px-3.5 py-2.5 text-[13px] leading-relaxed text-text", styles[tone])}>
      {icon && <span className="mt-0.5 shrink-0 [&_svg]:size-4">{icon}</span>}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
