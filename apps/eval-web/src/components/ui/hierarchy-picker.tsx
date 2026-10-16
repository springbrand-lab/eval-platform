import { useState, type ReactNode } from "react";
import {
  Button, Collapsible, CollapsibleContent, CollapsibleTrigger, Popover, PopoverContent,
  PopoverDescription, PopoverTitle, PopoverTrigger,
} from "@springbrand/site-block";
import { ChevronDown, ChevronRight, Layers } from "lucide-react";
import { Checkbox } from "./form";

export function HierarchyPicker({ summary, disabled, path, children }: { summary: ReactNode; disabled?: boolean; path: string; children: ReactNode }) {
  return <Popover>
    <PopoverTrigger asChild>
      <Button type="button" variant="outline" disabled={disabled} className="h-auto min-h-12 w-full justify-between gap-3 px-4 py-3 text-left">
        <Layers className="size-4 shrink-0 text-text-muted" /><span className="min-w-0 flex-1 whitespace-normal">{summary}</span><ChevronDown className="size-4 shrink-0" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" className="w-[min(44rem,calc(100vw-2rem))] overflow-hidden p-0">
      <div className="border-b border-border px-4 py-3">
        <PopoverTitle>选择层级范围</PopoverTitle>
        <PopoverDescription className="mt-1 text-xs">{path}</PopoverDescription>
      </div>
      {children}
    </PopoverContent>
  </Popover>;
}

export function HierarchyBranch({ label, detail, checked, onCheckedChange, disabled, defaultOpen = false, forceOpen = false, collapsible = true, children, actions }: {
  label: string; detail?: ReactNode; checked?: boolean | "indeterminate"; onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean; defaultOpen?: boolean; forceOpen?: boolean; collapsible?: boolean; children?: ReactNode; actions?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return <Collapsible open={!collapsible || forceOpen || open} onOpenChange={setOpen}
    className={!collapsible && children ? "overflow-hidden rounded-lg border border-border" : undefined}>
    <div className={`flex min-w-0 items-center gap-2 rounded-md px-2 py-2.5 hover:bg-surface-muted/60 ${!collapsible && children ? "bg-surface-muted/60" : ""}`}>
      {collapsible && (children ? <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" aria-label={`${forceOpen || open ? "收起" : "展开"} ${label}`}>
          <ChevronRight className={`size-4 transition-transform ${forceOpen || open ? "rotate-90" : ""}`} />
        </Button>
      </CollapsibleTrigger> : <span className="w-7 shrink-0" />)}
      {onCheckedChange ? <Checkbox label={<span title={label} className={`block truncate ${children ? "font-semibold" : ""}`}>{label}</span>} description={detail}
        className="min-w-0 flex-1 [&>label]:min-w-0 [&>label]:flex-1" checked={checked ?? false} disabled={disabled} onCheckedChange={onCheckedChange} />
        : <div className="min-w-0 flex-1"><span title={label} className="block truncate text-sm font-medium">{label}</span>{detail && <div className="mt-1 text-xs text-text-muted">{detail}</div>}</div>}
      {actions}
    </div>
    {children && <CollapsibleContent><div className="ml-5 min-w-0 border-l border-border pl-2 sm:pl-4">{children}</div></CollapsibleContent>}
  </Collapsible>;
}
