import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export function CopyButton({ value, className, label = "复制" }: { value: string; className?: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className={cn("rounded p-1 text-text-faint transition-colors hover:bg-surface-muted hover:text-text-strong", className)}
    >
      {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
    </button>
  );
}

/** A long ID shown short in monospace, with copy. */
export function CopyId({ value, length = 8 }: { value: string; length?: number }) {
  return (
    <span className="inline-flex items-center gap-0.5 font-mono text-xs text-text-muted" title={value}>
      {value.length > length ? `${value.slice(0, length)}…` : value}
      <CopyButton value={value} label="复制 ID" />
    </span>
  );
}

export function CodeBlock({ value, className, maxHeight = "28rem" }: { value: string; className?: string; maxHeight?: string }) {
  return (
    <div className={cn("group relative rounded-[var(--radius-control)] border border-border bg-surface-code", className)}>
      <CopyButton value={value} className="absolute right-2 top-2 opacity-0 transition-opacity group-hover:opacity-100" />
      <pre className="overflow-auto p-3 pr-10 font-mono text-[12.5px] leading-relaxed text-text" style={{ maxHeight }}>{value}</pre>
    </div>
  );
}

function JsonPrimitive({ value }: { value: unknown }) {
  const [expanded, setExpanded] = useState(false);
  if (typeof value === "string") {
    const long = value.length > 300;
    return (
      <span className="text-success">
        {JSON.stringify(long && !expanded ? `${value.slice(0, 300)}…` : value)}
        {long && (
          <button type="button" className="ml-1 font-sans text-xs text-link" onClick={() => setExpanded(!expanded)}>
            {expanded ? "收起" : "展开"}
          </button>
        )}
      </span>
    );
  }
  if (typeof value === "number") return <span className="text-info">{String(value)}</span>;
  if (typeof value === "boolean") return <span className="text-warning">{String(value)}</span>;
  return <span className="text-text-faint">{String(value)}</span>;
}

function JsonNode({ name, value, depth }: { name?: string; value: unknown; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const label = name !== undefined && <span className="text-text-secondary">{name}: </span>;
  if (value === null || typeof value !== "object") {
    return <div className="break-all py-px">{label}<JsonPrimitive value={value} /></div>;
  }
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : Object.entries(value);
  const brackets = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  return (
    <div>
      <button type="button" className="inline-flex items-center py-px text-left hover:text-text-strong" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="size-3 text-text-faint" /> : <ChevronRight className="size-3 text-text-faint" />}
        {label}
        <span className="text-text-faint">{brackets[0]}{!open && ` ${entries.length} 项 ${brackets[1]}`}</span>
      </button>
      {open && (
        <div className="ml-[5px] border-l border-border pl-3">
          {entries.map(([key, item]) => <JsonNode key={key} name={key} value={item} depth={depth + 1} />)}
          <span className="text-text-faint">{brackets[1]}</span>
        </div>
      )}
    </div>
  );
}

export function JsonViewer({ value, className }: { value: unknown; className?: string }) {
  return (
    <div className={cn("group relative overflow-auto rounded-[var(--radius-control)] border border-border bg-surface-code p-3 font-mono text-[12.5px] leading-relaxed text-text", className)}>
      <CopyButton value={JSON.stringify(value, null, 2)} className="absolute right-2 top-2 opacity-0 transition-opacity group-hover:opacity-100" />
      <JsonNode value={value} depth={0} />
    </div>
  );
}

export function MetricCard({ label, value, hint, tone, icon }: {
  label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: "success" | "danger" | "warning"; icon?: ReactNode;
}) {
  const color = tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-text-strong";
  return (
    <div className="flex min-w-0 flex-col rounded-[var(--radius-card)] border border-border bg-surface px-4 py-3.5">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-text-muted [&_svg]:size-3.5">{icon}{label}</p>
      <p className={cn("mt-2 truncate text-2xl font-semibold leading-none tracking-tight tabular", color)}>{value}</p>
      {hint && <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-text-muted" title={typeof hint === "string" ? hint : undefined}>{hint}</p>}
    </div>
  );
}

/** A score on its Schema range; values outside the range are clamped for display only. */
export function ScoreBar({ value, min = 0, max = 10 }: { value: number | null | undefined; min?: number; max?: number }) {
  if (value === null || value === undefined) return <span className="text-text-faint">—</span>;
  const ratio = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
  const color = ratio >= 0.7 ? "bg-success" : ratio >= 0.4 ? "bg-warning" : "bg-danger";
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-muted">
        <span className={cn("block h-full rounded-full", color)} style={{ width: `${ratio * 100}%` }} />
      </span>
      <span className="font-semibold text-text-strong tabular">{Number.isInteger(value) ? value : value.toFixed(2)}</span>
    </span>
  );
}

/** Segmented control, as in Langfuse's view switchers. */
export function Tabs<T extends string>({ tabs, value, onChange }: {
  tabs: readonly { value: T; label: ReactNode; count?: number }[]; value: T; onChange: (value: T) => void;
}) {
  return (
    <div role="tablist" className="inline-flex h-9 items-center gap-0.5 rounded-lg bg-surface-muted p-1">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={tab.value === value}
          onClick={() => onChange(tab.value)}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-[13px] font-semibold transition-colors",
            tab.value === value ? "bg-surface text-text-strong shadow-sm" : "text-text-muted hover:text-text-strong",
          )}
        >
          {tab.label}
          {tab.count !== undefined && <span className="text-xs text-text-faint tabular">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Stepper({ steps, current, onSelect }: { steps: readonly string[]; current: number; onSelect?: (index: number) => void }) {
  return (
    <ol className="flex flex-wrap items-center gap-1 text-[13px]">
      {steps.map((step, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li key={step} className="flex items-center gap-1">
            <button
              type="button"
              disabled={!onSelect || index > current}
              onClick={() => onSelect?.(index)}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1 transition-colors",
                active ? "text-text-strong" : done ? "text-text-secondary hover:bg-surface-muted" : "text-text-faint",
              )}
            >
              <span className={cn(
                "flex size-5 items-center justify-center rounded-full text-[11px] font-semibold",
                done ? "bg-success-soft text-success" : active ? "bg-primary text-primary-fg" : "border border-border-strong text-text-faint",
              )}>
                {done ? <Check className="size-3" /> : index + 1}
              </span>
              <span className={active ? "font-semibold" : undefined}>{step}</span>
            </button>
            {index < steps.length - 1 && <ChevronRight className="size-3.5 text-text-faint" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}

/** A compact horizontal bar of status counts, e.g. a Run's progress. */
export function ProgressBar({ segments, total }: {
  segments: readonly { value: number; tone: "success" | "danger" | "warning" | "info" | "neutral"; label: string }[];
  total: number;
}) {
  const colors = { success: "bg-success", danger: "bg-danger", warning: "bg-warning", info: "bg-info", neutral: "bg-border-strong" };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
        {segments.filter((segment) => segment.value > 0).map((segment) => (
          <span key={segment.label} className={colors[segment.tone]} style={{ width: `${total > 0 ? (segment.value / total) * 100 : 0}%` }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-muted">
        {segments.map((segment) => (
          <span key={segment.label} className="inline-flex items-center gap-1.5">
            <span className={cn("size-1.5 rounded-full", colors[segment.tone])} />
            {segment.label} <span className="text-text-strong tabular">{segment.value}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
