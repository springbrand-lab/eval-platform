import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type Tone = "neutral" | "primary" | "success" | "warning" | "danger" | "info";

const tones: Record<Tone, string> = {
  neutral: "bg-surface-muted text-text-muted",
  primary: "bg-primary-soft text-primary",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
};

export function Badge({ tone = "neutral", children, className, dot }: {
  tone?: Tone; children: ReactNode; className?: string; dot?: boolean;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", tones[tone], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

const STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: "排队中", tone: "info" },
  starting: { label: "启动中", tone: "info" },
  running: { label: "运行中", tone: "warning" },
  retrying: { label: "重试中", tone: "warning" },
  succeeded: { label: "成功", tone: "success" },
  completed: { label: "已完成", tone: "success" },
  failed: { label: "失败", tone: "danger" },
  interrupted: { label: "已中断", tone: "danger" },
  cancelled: { label: "已取消", tone: "neutral" },
  "not-started": { label: "未开始", tone: "info" },
  available: { label: "可查看", tone: "success" },
  synced: { label: "已同步", tone: "success" },
  valid: { label: "格式正确", tone: "success" },
  invalid: { label: "格式错误", tone: "danger" },
  unavailable: { label: "无结果", tone: "neutral" },
  complete: { label: "完整", tone: "success" },
  partial: { label: "部分", tone: "warning" },
};

/** Status is shown as text and colour together, never colour alone. */
export function StatusBadge({ status, className }: { status: string | null | undefined; className?: string }) {
  if (!status) return <Badge className={className}>—</Badge>;
  const entry = STATUS[status] ?? { label: status, tone: "neutral" as const };
  return <Badge tone={entry.tone} dot className={className}>{entry.label}</Badge>;
}
