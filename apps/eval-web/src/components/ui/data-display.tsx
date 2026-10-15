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
      className={cn("rounded p-1 text-text-muted hover:bg-surface-muted hover:text-text", className)}
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
    <div className={cn("relative rounded-[var(--radius-control)] border border-border bg-surface-muted", className)}>
      <CopyButton value={value} className="absolute right-2 top-2" />
      <pre className="overflow-auto p-3 pr-10 font-mono text-[12.5px] leading-relaxed text-text" style={{ maxHeight }}>{value}</pre>
    </div>
  );
}

function JsonNode({ name, value, depth }: { name?: string; value: unknown; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const label = name !== undefined && <span className="text-primary">{name}: </span>;
  if (value === null || typeof value !== "object") {
    const text = typeof value === "string" ? JSON.stringify(value) : String(value);
    const long = typeof value === "string" && value.length > 300;
    const [expanded, setExpanded] = [open, setOpen];
    return (
      <div className="break-all">
        {label}
        <span className={typeof value === "string" ? "text-success" : "text-warning"}>
          {long && !expanded ? `${text.slice(0, 300)}…` : text}
        </span>
        {long && (
          <button type="button" className="ml-1 text-xs text-primary" onClick={() => setExpanded(!expanded)}>
            {expanded ? "收起" : "展开"}
          </button>
        )}
      </div>
    );
  }
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : Object.entries(value);
  const brackets = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  return (
    <div>
      <button type="button" className="inline-flex items-center text-left" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        {label}
        <span className="text-text-muted">{brackets[0]}{!open && `${entries.length} 项${brackets[1]}`}</span>
      </button>
      {open && (
        <div className="ml-4 border-l border-border pl-2">
          {entries.map(([key, item]) => <JsonNode key={key} name={key} value={item} depth={depth + 1} />)}
          <span className="text-text-muted">{brackets[1]}</span>
        </div>
      )}
    </div>
  );
}

export function JsonViewer({ value, className }: { value: unknown; className?: string }) {
  return (
    <div className={cn("relative overflow-auto rounded-[var(--radius-control)] border border-border bg-surface-muted p-3 font-mono text-[12.5px] leading-relaxed", className)}>
      <CopyButton value={JSON.stringify(value, null, 2)} className="absolute right-2 top-2" />
      <JsonNode value={value} depth={0} />
    </div>
  );
}

export function MetricCard({ label, value, hint, tone }: {
  label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: "success" | "danger" | "warning";
}) {
  const color = tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-text";
  return (
    <div className="rounded-[var(--radius-card)] border border-border bg-surface px-4 py-3">
      <p className="text-xs text-text-muted">{label}</p>
      <p className={cn("mt-1 text-[28px] font-semibold leading-tight tabular", color)}>{value}</p>
      {hint && <p className="mt-1 text-xs text-text-muted">{hint}</p>}
    </div>
  );
}

/** A score on its Schema range; values outside the range are clamped for display only. */
export function ScoreBar({ value, min = 0, max = 10 }: { value: number | null | undefined; min?: number; max?: number }) {
  if (value === null || value === undefined) return <span className="text-text-muted">—</span>;
  const ratio = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
  const color = ratio >= 0.7 ? "bg-success" : ratio >= 0.4 ? "bg-warning" : "bg-danger";
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-muted">
        <span className={cn("block h-full rounded-full", color)} style={{ width: `${ratio * 100}%` }} />
      </span>
      <span className="font-medium tabular">{Number.isInteger(value) ? value : value.toFixed(2)}</span>
    </span>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: {
  tabs: readonly { value: T; label: ReactNode }[]; value: T; onChange: (value: T) => void;
}) {
  return (
    <div role="tablist" className="flex gap-1 border-b border-border">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={tab.value === value}
          onClick={() => onChange(tab.value)}
          className={cn(
            "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
            tab.value === value ? "border-primary text-text" : "border-transparent text-text-muted hover:text-text",
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function Stepper({ steps, current }: { steps: readonly string[]; current: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-2 text-sm">
      {steps.map((step, index) => (
        <li key={step} className="flex items-center gap-2">
          <span className={cn(
            "flex size-6 items-center justify-center rounded-full text-xs font-semibold",
            index < current ? "bg-success text-white" : index === current ? "bg-primary text-white" : "bg-surface-muted text-text-muted",
          )}>
            {index < current ? <Check className="size-3.5" /> : index + 1}
          </span>
          <span className={index === current ? "font-medium text-text" : "text-text-muted"}>{step}</span>
          {index < steps.length - 1 && <span className="mx-1 h-px w-6 bg-border" aria-hidden />}
        </li>
      ))}
    </ol>
  );
}
