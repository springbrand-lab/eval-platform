import { Check, ChevronRight, Copy } from "lucide-react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { JsonView } from "react-json-view-lite";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Tooltip } from "./tooltip";

export function CopyButton({ value, className, label = "复制" }: { value: string; className?: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip content={copied ? "已复制" : label}>
    <button
      type="button"
      aria-label={label}
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
    </Tooltip>
  );
}

/** A long ID shown short in monospace, with copy. */
export function CopyId({ value, length = 8 }: { value: string; length?: number }) {
  return (
    <span className="inline-flex items-center gap-0.5 font-mono text-xs text-text-muted">
      {value.length > length ? `${value.slice(0, length)}…` : value}
      <CopyButton value={value} label="复制 ID" />
    </span>
  );
}

export function CodeBlock({ value, className, maxHeight = "28rem" }: { value: string; className?: string; maxHeight?: string }) {
  return (
    <div className={cn("group relative rounded-[var(--radius-control)] border border-border bg-surface-code", className)}>
      <CopyButton value={value} className="absolute right-2 top-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100" />
      <pre className="overflow-auto p-3 pr-10 font-mono text-[12.5px] leading-relaxed text-text" style={{ maxHeight }}>{value}</pre>
    </div>
  );
}

const jsonStyles = {
  container: "font-mono text-[12.5px] leading-relaxed text-text",
  basicChildStyle: "pl-4",
  childFieldsContainer: "",
  label: "mr-1 text-text-secondary",
  clickableLabel: "mr-1 cursor-pointer text-text-secondary",
  nullValue: "text-text-faint",
  undefinedValue: "text-text-faint",
  stringValue: "break-all text-success",
  booleanValue: "text-warning",
  numberValue: "text-info",
  otherValue: "text-text",
  punctuation: "text-text-faint",
  expandIcon: "mr-1 inline-block w-3 text-text-faint after:content-['▸']",
  collapseIcon: "mr-1 inline-block w-3 text-text-faint after:content-['▾']",
  collapsedContent: "px-1 text-text-faint after:content-['…']",
  noQuotesForStringValues: false,
  quotesForFieldNames: false,
  ariaLables: { collapseJson: "折叠", expandJson: "展开" },
  stringifyStringValues: false,
};

/** Expanded to every level by default; nodes can still be collapsed by hand. */
export function JsonViewer({ value, className, expandLevels = Infinity }: { value: unknown; className?: string; expandLevels?: number }) {
  const data = value !== null && typeof value === "object" ? value as object : { value };
  return (
    <div className={cn("group relative overflow-auto rounded-[var(--radius-control)] border border-border bg-surface-code p-3", className)}>
      <CopyButton value={JSON.stringify(value, null, 2)} className="absolute right-2 top-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100" />
      <JsonView data={data} shouldExpandNode={(level) => level < expandLevels} style={jsonStyles} />
    </div>
  );
}

export function MetricCard({ label, value, hint, tone, icon }: {
  label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: "success" | "danger" | "warning"; icon?: ReactNode;
}) {
  const color = tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-text-strong";
  return (
    <div className="flex min-w-0 flex-col rounded-[var(--radius-card)] border border-border bg-surface px-5 py-5">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-text-muted [&_svg]:size-3.5">{icon}{label}</p>
      <div className={cn("mt-3 text-2xl font-semibold leading-tight tracking-tight tabular", color)}>{value}</div>
      {hint && <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-text-muted" title={typeof hint === "string" ? hint : undefined}>{hint}</p>}
    </div>
  );
}

/** Segmented control (Radix Tabs list); the caller renders the selected view. */
export function Tabs<T extends string>({ tabs, value, onChange }: {
  tabs: readonly { value: T; label: ReactNode; count?: number }[]; value: T; onChange: (value: T) => void;
}) {
  return (
    <TabsPrimitive.Root value={value} onValueChange={(next) => onChange(next as T)}>
      <TabsPrimitive.List className="inline-flex h-9 items-center gap-0.5 rounded-lg bg-surface-muted p-1">
        {tabs.map((tab) => (
          <TabsPrimitive.Trigger
            key={tab.value}
            value={tab.value}
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-[13px] font-semibold text-text-muted transition-colors hover:text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=active]:bg-surface data-[state=active]:text-text-strong data-[state=active]:shadow-sm"
          >
            {tab.label}
            {tab.count !== undefined && <span className="text-xs text-text-faint tabular">{tab.count}</span>}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
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
